import "server-only";

import { LocalAgentJobStatus } from "@prisma/client";

import { requireCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import {
  getBestFbrTrustedDeviceForUser,
  getTrustedFbrDeviceReadinessForUser,
  queueLocalAgentJob,
} from "@/lib/ejari/local-agent";
import { getPacketEvidenceReadinessReasons, getTaxApprovalWorkspace } from "@/lib/tax/approvals";
import { getUnifiedPaymentReadiness } from "@/lib/tax/payments";

import { getTaxAssistedFilingReadiness } from "@/lib/tax/fbr-assisted-filing";
import { getActiveFbrSelectorBundle } from "@/lib/tax/fbr-agent-config";
import { parseTaxDraftMetadata } from "@/lib/tax/draft-metadata";
import { resolveIrisRouteWithWealthStatement } from "@/lib/tax/iris-route-resolver";
import type { RouteResolutionResult } from "@/lib/tax/iris-route-resolver";

const ACTIVE_JOB_STATUSES: LocalAgentJobStatus[] = [
  "created",
  "offered_to_device",
  "accepted_by_device",
  "running",
  "awaiting_user_action",
];

function parseJson<T>(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function getTaxDryRunReadiness(draftId: string) {
  const workspace = await getTaxApprovalWorkspace(draftId);
  const approval = workspace.currentApproval;
  const packet = workspace.currentPacket;
  const reasons: string[] = [];

  // Resolve IRIS route for this draft
  const metadata = parseTaxDraftMetadata(workspace.draft.metadataJson);
  const irisRoute = resolveIrisRouteWithWealthStatement(metadata);

  if (!packet) {
    reasons.push("Generate a current filing packet before launching a dry run.");
  }

  if (!approval) {
    reasons.push("Record client approval before launching local Iris dry run.");
  }

  if (approval && packet) {
    if (approval.taxFilingPacketId !== packet.id) {
      reasons.push("Client approval no longer matches the current packet.");
    }
    if (
      approval.approvedPacketVersion !== packet.packetVersion ||
      approval.approvedPacketHash !== packet.packetHash
    ) {
      reasons.push("Client approval no longer matches the current packet version/hash.");
    }
    if (!approval.consentPortalAutomation) {
      reasons.push("Portal automation consent is missing on the current approval.");
    }
  }

  if (workspace.riskWorkspace.flags.some((flag) => flag.status === "open" && flag.blocking)) {
    reasons.push("Resolve blocking risks before launching the dry run.");
  }

  if (!packet?.snapshot?.wealthStatement?.isResolved) {
    reasons.push("Wealth reconciliation must be resolved before the dry run.");
  }

  if (packet?.snapshot) {
    reasons.push(...getPacketEvidenceReadinessReasons(packet.snapshot));
  }

  // ── Route-aware readiness checks (TR-V8-024) ────────────────────
  if (irisRoute.unsupported) {
    reasons.push(
      irisRoute.unsupportedReasons.length > 0
        ? irisRoute.unsupportedReasons[0]
        : "This filing is outside the V8 supported route set and cannot be queued for a dry run.",
    );
  } else if (!irisRoute.resolved) {
    reasons.push("The IRIS route for this filing has not been resolved. Complete route resolution before launching a dry run.");
  } else if (irisRoute.routeEntry && !irisRoute.routeEntry.supportedInV8) {
    reasons.push("The resolved route is not supported in V8. Dry runs are not available for this route.");
  } else if (irisRoute.routeEntry?.preStepApplicationRequirement) {
    reasons.push("A pre-step application (e.g. 114I election) is required before launching a dry run.");
  }

  // ── Payment-state-machine readiness for dry run ──────────────────
  // Dry runs do not require full payment readiness, but we check for
  // obvious blockers that would prevent the dry run from completing
  if (packet?.snapshot) {
    const taxPayable = packet.snapshot.returnSummary.taxPayable ?? 0;
    if (taxPayable > 1) {
      // For payable returns, the dry run should at least be able to
      // reach the PSID generation step — flag if PSID is already generated
      // and unpaid (dry run would be redundant)
      try {
        const paymentReadiness = await getUnifiedPaymentReadiness(draftId);
        if (paymentReadiness.derivedState === "psid_generated_unpaid") {
          reasons.push("PSID is already generated and unpaid. Launch an assisted filing instead of a dry run to complete the payment workflow.");
        }
        if (paymentReadiness.derivedState === "payment_submitted_pending_confirmation") {
          reasons.push("Payment is pending confirmation. Launch an assisted filing to verify CPR and complete submission.");
        }
        if (paymentReadiness.derivedState === "ready_to_submit" || paymentReadiness.derivedState === "refund_available_ready_to_submit") {
          reasons.push("Payment is already complete and ready for submission. Launch an assisted filing instead of a dry run.");
        }
      } catch {
        reasons.push("Payment readiness could not be determined. Refresh and retry before launching a dry run.");
      }
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    workspace,
    approval,
    packet,
    irisRoute,
  };
}

export async function queueTaxDryRunJob(draftId: string) {
  const user = await requireCurrentUser();
  const [readiness, trustedDevice, selectorBundleConfig] = await Promise.all([
    getTaxDryRunReadiness(draftId),
    getBestFbrTrustedDeviceForUser(user.id),
    getActiveFbrSelectorBundle({ userId: user.id }),
  ]);

  if (!readiness.ready || !readiness.packet) {
    throw new Error(readiness.reasons[0] || "This filing is not ready for a dry run.");
  }

  if (!trustedDevice) {
    throw new Error("Connect a trusted FBR desktop device first.");
  }

  const idempotencyKey = `tax-dry-run:${readiness.workspace.draft.id}:${readiness.packet.id}:${readiness.packet.packetHash}`;
  const existingJob = await db.localAgentJob.findFirst({
    where: {
      userId: user.id,
      idempotencyKey,
      status: {
        in: ACTIVE_JOB_STATUSES,
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (existingJob) {
    return existingJob;
  }

  const routeFamily = readiness.packet.snapshot?.routeMetadata?.routeFamily ?? null;
  const selectorBundleSignal = {
    bundleId: selectorBundleConfig.activeBundle.bundleId,
    bundleVersion: selectorBundleConfig.activeBundle.bundleVersion,
    bundleSource: selectorBundleConfig.activeBundle.source,
    bundleHash: selectorBundleConfig.activeBundle.hash,
    routeFamily,
  };

  const job = await queueLocalAgentJob({
    userId: user.id,
    trustedDeviceId: trustedDevice.id,
    type: "tax_dry_run",
    taxFilingDraftId: readiness.workspace.draft.id,
    taxFilingPacketId: readiness.packet.id,
    idempotencyKey,
    payload: {
      flow: "fbr_tax_dry_run",
      dryRun: true,
      filingDraftId: readiness.workspace.draft.id,
      filingPacketId: readiness.packet.id,
      packetVersion: readiness.packet.packetVersion,
      packetHash: readiness.packet.packetHash,
      selectorBundle: selectorBundleSignal,
      createdAt: new Date().toISOString(),
    },
  });

  // ── TR-V8-033: Audit trail for dry run queue ──────────────────────
  await db.taxAuditEvent.create({
    data: {
      ownerUserId: readiness.workspace.draft.ownerUserId,
      taxFilingDraftId: readiness.workspace.draft.id,
      actorType: "user",
      actorId: user.id,
      eventType: "tax_dry_run_queued",
      eventDataJson: JSON.stringify({
        localAgentJobId: job.id,
        packetId: readiness.packet.id,
        packetVersion: readiness.packet.packetVersion,
        packetHash: readiness.packet.packetHash,
        selectorBundle: selectorBundleSignal,
        trustedDevicePublicId: trustedDevice.publicId,
      }),
    },
  });

  return job;

}

export async function getFbrConnectWorkspace(draftId?: string | null) {
  const user = await requireCurrentUser();
  const [deviceReadiness, selectorBundleConfig] = await Promise.all([
    getTrustedFbrDeviceReadinessForUser(user.id),
    getActiveFbrSelectorBundle({ userId: user.id }),
  ]);

  const jobs = await db.localAgentJob.findMany({
    where: {
      userId: user.id,
      ...(draftId ? { taxFilingDraftId: draftId } : {}),
      type: {
        in: ["tax_dry_run", "tax_assisted_filing"],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 10,
    include: {
      trustedDevice: true,
      taxFilingDraft: true,
      taxFilingPacket: true,
    },
  });

  const dryRunReadiness = draftId ? await getTaxDryRunReadiness(draftId) : null;
  const assistedReadiness = draftId ? await getTaxAssistedFilingReadiness(draftId) : null;

  return {
    user,
    deviceReadiness,
    dryRunReadiness,
    assistedReadiness,
    selectorBundle: selectorBundleConfig.activeBundle,
    jobs: jobs.map((job) => ({
      id: job.id,
      publicId: job.publicId,
      status: job.status,
      type: job.type,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      trustedDevice: {
        publicId: job.trustedDevice.publicId,
        displayName: job.trustedDevice.displayName,
      },
      draftId: job.taxFilingDraftId,
      packetId: job.taxFilingPacketId,
      payload: parseJson<Record<string, unknown>>(job.payloadJson),
      result: parseJson<Record<string, unknown>>(job.resultJson),
      executionLog: parseJson<Array<Record<string, unknown>>>(job.executionLogJson),
    })),
  };
}
