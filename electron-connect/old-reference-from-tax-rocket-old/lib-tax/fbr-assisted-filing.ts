import "server-only";

import { type LocalAgentJob, type Prisma } from "@prisma/client";

import { requireCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getBestFbrTrustedDeviceForUser, queueLocalAgentJob } from "@/lib/ejari/local-agent";
import { getPacketEvidenceReadinessReasons, getTaxApprovalWorkspace } from "@/lib/tax/approvals";
import { getActiveFbrSelectorBundle } from "@/lib/tax/fbr-agent-config";
import { getUnifiedPaymentReadiness } from "@/lib/tax/payments";

import { parseTaxDraftMetadata } from "@/lib/tax/draft-metadata";
import { resolveIrisRouteWithWealthStatement } from "@/lib/tax/iris-route-resolver";
import type { RouteResolutionResult } from "@/lib/tax/iris-route-resolver";

const ACTIVE_JOB_STATUSES = [
  "created",
  "offered_to_device",
  "accepted_by_device",
  "running",
  "awaiting_user_action",
] as const;

type AssistedPauseAction =
  | "password_reset"
  | "otp_captcha_pin"
  | "payment_psid"
  | "payment_verification"
  | "session_reconnect"
  | "selector_bundle_update"
  | "final_submit_confirmation";

type AssistedPilotState = {
  phase:
    | "start"
    | "after_password_reset"
    | "after_otp_captcha_pin"
    | "after_payment_psid"
    | "after_final_submit_confirmation";
  confirmations: Array<{
    action: AssistedPauseAction;
    confirmedAt: string;
    confirmedByUserId: string;
  }>;
};

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

function getInitialPilotState(): AssistedPilotState {
  return {
    phase: "start",
    confirmations: [],
  };
}

function serializeMetadata(metadata: Record<string, unknown> | undefined) {
  return metadata ? JSON.stringify(metadata) : null;
}

async function createTaxAuditEvent(
  tx: Prisma.TransactionClient,
  input: {
    ownerUserId: string;
    draftId: string;
    actorType: "user" | "system" | "bot" | "admin";
    actorId?: string | null;
    eventType: string;
    eventData: Record<string, unknown>;
  },
) {
  await tx.taxAuditEvent.create({
    data: {
      ownerUserId: input.ownerUserId,
      taxFilingDraftId: input.draftId,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      eventType: input.eventType,
      eventDataJson: JSON.stringify(input.eventData),
    },
  });
}

export async function getTaxAssistedFilingReadiness(draftId: string) {
  const workspace = await getTaxApprovalWorkspace(draftId);
  const approval = workspace.currentApproval;
  const packet = workspace.currentPacket;
  const metadata = workspace.draft.metadataJson ? parseJson<Record<string, unknown>>(workspace.draft.metadataJson) : null;
  const reasons: string[] = [];

  // Resolve IRIS route for this draft
  const draftMetadata = parseTaxDraftMetadata(workspace.draft.metadataJson);
  const irisRoute = resolveIrisRouteWithWealthStatement(draftMetadata);

  if (!packet) {
    reasons.push("Generate a current filing packet before starting assisted filing.");
  }

  if (!approval) {
    reasons.push("Record client approval before starting assisted filing.");
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

  if (!packet?.snapshot?.wealthStatement?.isResolved) {
    reasons.push("Wealth reconciliation must be resolved before assisted filing.");
  }

  if (packet?.snapshot) {
    reasons.push(...getPacketEvidenceReadinessReasons(packet.snapshot));
  }

  if (workspace.riskWorkspace.flags.some((flag) => flag.status === "open" && flag.blocking)) {
    reasons.push("Resolve blocking risks before assisted filing.");
  }

  const complexityScore =
    typeof metadata?.complexityScore === "number" ? metadata.complexityScore : null;
  const modeRecommendation =
    typeof metadata?.modeRecommendation === "string" ? metadata.modeRecommendation : null;

  if (
    modeRecommendation !== "mode_1" &&
    modeRecommendation !== "mode_1_optional_review"
  ) {
    reasons.push("This filing is not routed into the supervised Mode 1 pilot path.");
  }

  if (complexityScore !== null && complexityScore >= 6) {
    reasons.push("This pilot only supports simpler salaried or non-business cases.");
  }

  // ── Route-aware readiness checks (TR-V8-024) ────────────────────
  if (irisRoute.unsupported) {
    reasons.push(
      irisRoute.unsupportedReasons.length > 0
        ? irisRoute.unsupportedReasons[0]
        : "This filing is outside the V8 supported route set and cannot be queued for assisted filing.",
    );
  } else if (!irisRoute.resolved) {
    reasons.push("The IRIS route for this filing has not been resolved. Complete route resolution before starting assisted filing.");
  } else if (irisRoute.routeEntry && !irisRoute.routeEntry.supportedInV8) {
    reasons.push("The resolved route is not supported in V8. Assisted filing is not available for this route.");
  } else if (irisRoute.routeEntry?.preStepApplicationRequirement) {
    reasons.push("A pre-step application (e.g. 114I election) is required before assisted filing can begin.");
  }

  // ── Payment-state-machine readiness for assisted filing (TR-V8-024) ──
  // Assisted filing requires payment readiness for payable returns
  if (packet?.snapshot) {
    const taxPayable = packet.snapshot.returnSummary.taxPayable ?? 0;
    if (taxPayable > 1) {
      try {
        const paymentReadiness = await getUnifiedPaymentReadiness(draftId);
        // Block queueing when payment prerequisites are not satisfied
        if (paymentReadiness.derivedState === "ready_to_generate_psid") {
          reasons.push("PSID has not been generated yet. The assisted filing will pause at PSID generation — ensure you are ready to generate a PSID on the trusted device.");
        }
        if (paymentReadiness.derivedState === "psid_generated_unpaid") {
          reasons.push("PSID is generated but payment is not yet complete. The assisted filing will pause for payment — complete the payment on the trusted device.");
        }
        if (paymentReadiness.derivedState === "payment_submitted_pending_confirmation") {
          reasons.push("Payment is pending CPR confirmation. The assisted filing will verify CPR status on the portal.");
        }
        if (paymentReadiness.derivedState === "underpaid_blocked") {
          reasons.push("The recorded payment is less than the balance payable. Complete the remaining payment before assisted filing can proceed to submission.");
        }
        if (paymentReadiness.derivedState === "failed") {
          reasons.push("Payment state is inconsistent or unrecoverable. Correct the payment record before assisted filing.");
        }
        // For states not explicitly handled above, still block when the payment
        // readiness engine marks the state as not ready.
        if (!paymentReadiness.ready && paymentReadiness.reasons.length > 0) {
          reasons.push(...paymentReadiness.reasons);
        }
      } catch {
        reasons.push("Payment readiness could not be determined. Refresh and retry before starting assisted filing.");
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

export async function queueTaxAssistedFilingJob(draftId: string) {
  const user = await requireCurrentUser();
  const [readiness, trustedDevice, selectorBundleConfig] = await Promise.all([
    getTaxAssistedFilingReadiness(draftId),
    getBestFbrTrustedDeviceForUser(user.id),
    getActiveFbrSelectorBundle({ userId: user.id }),
  ]);

  if (!readiness.ready || !readiness.packet) {
    throw new Error(readiness.reasons[0] || "This filing is not ready for assisted filing.");
  }

  if (!trustedDevice) {
    throw new Error("Connect a trusted FBR desktop device first.");
  }

  const idempotencyKey = `tax-assisted-filing:${readiness.workspace.draft.id}:${readiness.packet.id}:${readiness.packet.packetHash}`;
  const existingJob = await db.localAgentJob.findFirst({
    where: {
      userId: user.id,
      idempotencyKey,
      status: {
        in: [...ACTIVE_JOB_STATUSES],
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
    type: "tax_assisted_filing",
    taxFilingDraftId: readiness.workspace.draft.id,
    taxFilingPacketId: readiness.packet.id,
    idempotencyKey,
    payload: {
      flow: "fbr_tax_assisted_filing",
      dryRun: false,
      filingDraftId: readiness.workspace.draft.id,
      filingPacketId: readiness.packet.id,
      packetVersion: readiness.packet.packetVersion,
      packetHash: readiness.packet.packetHash,
      selectorBundle: selectorBundleSignal,
      livePilotState: getInitialPilotState(),
      createdAt: new Date().toISOString(),
    },
  });

  await db.taxAuditEvent.create({
    data: {
      ownerUserId: readiness.workspace.draft.ownerUserId,
      taxFilingDraftId: readiness.workspace.draft.id,
      actorType: "user",
      actorId: user.id,
      eventType: "tax_assisted_filing_queued",
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

const NON_PHASE_ADVANCING_ACTIONS = new Set<AssistedPauseAction>([
  "payment_verification",
  "session_reconnect",
  "selector_bundle_update",
]);

function getNextPhaseForAction(
  action: AssistedPauseAction,
  currentPhase: AssistedPilotState["phase"],
): AssistedPilotState["phase"] {
  if (NON_PHASE_ADVANCING_ACTIONS.has(action)) {
    return currentPhase;
  }

  switch (action) {
    case "password_reset":
      return "after_password_reset";
    case "otp_captcha_pin":
      return "after_otp_captcha_pin";
    case "payment_psid":
      return "after_payment_psid";
    case "payment_verification":
    case "session_reconnect":
    case "selector_bundle_update":
      return currentPhase;
    case "final_submit_confirmation":
      return "after_final_submit_confirmation";
  }
}

export async function resumeTaxAssistedFilingJob(input: {
  jobId: string;
  action: AssistedPauseAction;
}) {
  const user = await requireCurrentUser();
  const job = await db.localAgentJob.findFirst({
    where: {
      id: input.jobId,
      userId: user.id,
      type: "tax_assisted_filing",
      status: "awaiting_user_action",
    },
    include: {
      trustedDevice: true,
    },
  });

  if (!job) {
    throw new Error("This assisted filing job is no longer waiting for your confirmation.");
  }

  const result = parseJson<Record<string, unknown>>(job.resultJson);
  const requiredAction =
    result && typeof result.requiredAction === "string" ? result.requiredAction : null;

  if (requiredAction !== input.action) {
    throw new Error("This job is waiting for a different recovery or confirmation step.");
  }

  const payload = parseJson<Record<string, unknown>>(job.payloadJson) ?? {};
  const livePilotState = (
    payload.livePilotState && typeof payload.livePilotState === "object"
      ? payload.livePilotState
      : getInitialPilotState()
  ) as AssistedPilotState;

  // ── TR-V8-031: Harden resume flow ──────────────────────────────────
  // Validate that the phase transition is consistent with the action
  const expectedPhase = getNextPhaseForAction(input.action, livePilotState.phase);
  const currentPhase = livePilotState.phase;

  // Validate phase ordering: ensure we're not skipping phases
  const phaseOrder: AssistedPilotState["phase"][] = [
    "start",
    "after_password_reset",
    "after_otp_captcha_pin",
    "after_payment_psid",
    "after_final_submit_confirmation",
  ];

  const currentPhaseIndex = phaseOrder.indexOf(currentPhase);
  const expectedPhaseIndex = phaseOrder.indexOf(expectedPhase);

  if (currentPhaseIndex < 0 || expectedPhaseIndex < 0) {
    throw new Error("The assisted filing job is in an unrecognized phase and cannot be resumed.");
  }

  // Allow resuming from the same phase (e.g., if the user confirmed but the device
  // did not pick up the job yet) or from the immediately preceding phase
  if (expectedPhaseIndex < currentPhaseIndex) {
    throw new Error(
      `This assisted filing job has already passed the "${input.action}" step. It is currently in phase "${currentPhase}".`,
    );
  }

  // Check for duplicate confirmations of the same action
  const existingConfirmation = (Array.isArray(livePilotState.confirmations) ? livePilotState.confirmations : [])
    .find((c) => c.action === input.action);

  if (existingConfirmation) {
    // Allow re-confirmation but log it as a re-try
    console.warn(
      `[TR-V8-031] Duplicate confirmation for action "${input.action}" on job ${job.id}. User ${user.id} is re-confirming.`,
    );
  }

  const updatedPilotState: AssistedPilotState = {
    phase: expectedPhase,
    confirmations: [
      ...(Array.isArray(livePilotState.confirmations) ? livePilotState.confirmations : []),
      {
        action: input.action,
        confirmedAt: new Date().toISOString(),
        confirmedByUserId: user.id,
      },
    ],
  };

  await db.$transaction(async (tx) => {
    await tx.localAgentJob.update({
      where: { id: job.id },
      data: {
        status: "offered_to_device",
        acceptedAt: null,
        startedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        errorMessage: null,
        payloadJson: JSON.stringify({
          ...payload,
          livePilotState: updatedPilotState,
        }),
      },
    });

    if (job.taxFilingDraftId) {
      await createTaxAuditEvent(tx, {
        ownerUserId: user.id,
        draftId: job.taxFilingDraftId,
        actorType: "user",
        actorId: user.id,
        eventType: "tax_assisted_filing_pause_confirmed",
        eventData: {
          localAgentJobId: job.id,
          pauseAction: input.action,
          trustedDevicePublicId: job.trustedDevice.publicId,
          phaseTransition: `${currentPhase} → ${expectedPhase}`,
          isRetry: Boolean(existingConfirmation),
        },
      });
    }
  });

  return {
    ok: true,
    nextPhase: updatedPilotState.phase,
  };
}


export async function getTaxPilotJobsForDraft(draftId: string) {
  const user = await requireCurrentUser();

  return db.localAgentJob.findMany({
    where: {
      userId: user.id,
      taxFilingDraftId: draftId,
      type: {
        in: ["tax_dry_run", "tax_assisted_filing"],
      },
    },
    include: {
      trustedDevice: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 20,
  });
}
