"use client";

import { useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  ShieldCheck,
  Download,
  Play,
  CheckCircle,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getFbrConnectionAction,
  startFbrConnectionAction,
  type FbrConnectionView,
} from "@/app/actions/fbr";
import {
  queueAssistedFilingJobAction,
  getLocalAgentJobsAction,
  cancelJobAction,
  resumeJobAfterPauseAction,
  getTrustedDevicesAction,
} from "@/app/actions/fbr-jobs";

type Props = Readonly<{
  draftId?: string;
  initialConnection: FbrConnectionView | null;
  onConnectionStatusChange?: (status: string) => void;
  /** Key figures shown on the final submit gate, when known. */
  taxPayable?: number | null;
  refundDue?: number | null;
  packetVersion?: number;
}>;

type DesktopSession = {
  launchToken: string;
  partitionKey: string;
  deepLink: string;
  localhostUrl: string;
  expiresAt: string;
};

type JobView = {
  id: string;
  jobType: string;
  status: string;
  pauseAction: string | null;
  pauseMessage: string | null;
  errorMessage: string | null;
  createdAt: string | Date;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
};

type DeviceView = {
  id: string;
  deviceName: string | null;
  partitionKey: string;
  status: string;
  localFbrConnectedAt: string | Date | null;
  lastSeenAt: string | Date | null;
  createdAt: string | Date;
};

type Phase = "connect" | "start" | "working" | "resume" | "done";
type FlowStep = "connect" | "start" | "resume";

const PAUSE_LABELS: Record<string, string> = {
  password_reset: "Password reset",
  otp_captcha_pin: "OTP / CAPTCHA / PIN",
  otp_required: "OTP",
  captcha_required: "CAPTCHA",
  pin_required: "PIN",
  payment_psid: "PSID payment",
  psid_payment: "PSID payment",
  final_submit_confirmation: "Final review",
  final_review: "Final review",
};

const ACTIVE_JOB_STATUSES = new Set([
  "created",
  "offered_to_device",
  "accepted_by_device",
  "running",
  "awaiting_user_action",
]);

// The desktop worker polls /api/local-agent/jobs/next every ~10s, which
// refreshes TrustedDevice.lastSeenAt. A device only counts as connected
// while that heartbeat is fresh; otherwise closing the agent left the flow
// stuck on "Start filing" with no way back to Step 1 to reconnect.
const AGENT_HEARTBEAT_FRESH_MS = 45_000;
// A just-created session keeps Step 2 visible while the deep link is still
// launching the agent (session expiry is creation time + 10 minutes).
const SESSION_GRACE_MS = 2 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;

const FLOW_STEPS: ReadonlyArray<{ id: FlowStep; n: string; label: string }> = [
  { id: "connect", n: "1", label: "Open agent" },
  { id: "start", n: "2", label: "Start filing" },
  { id: "resume", n: "3", label: "Confirm on screen" },
];

const FLOW_ORDER: FlowStep[] = ["connect", "start", "resume"];

function formatWhen(value: string | Date | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function flowStepForPhase(phase: Phase): FlowStep {
  if (phase === "connect") return "connect";
  if (phase === "start" || phase === "working") return "start";
  return "resume";
}

function isFinalSubmitPause(pauseAction: string | null) {
  const action = (pauseAction || "").toLowerCase();
  return (
    action.includes("final_submit") ||
    action.includes("final_review") ||
    action.includes("classic_final")
  );
}

function chipClass(isDone: boolean, isCurrent: boolean) {
  if (isDone) return "border-green-200 bg-green-50 text-green-800";
  if (isCurrent) return "border-amanah/30 bg-amanah/5 text-foreground";
  return "text-muted-foreground";
}

export default function FbrConnectClient({
  draftId,
  initialConnection,
  onConnectionStatusChange,
  taxPayable,
  refundDue,
  packetVersion,
}: Props) {
  const [connection, setConnection] = useState(initialConnection);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [startOver, setStartOver] = useState(false);
  const [installedAck, setInstalledAck] = useState(false);
  const [submitGateOpen, setSubmitGateOpen] = useState(true);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  useEffect(() => {
    onConnectionStatusChange?.(connection?.status ?? "NOT_STARTED");
  }, [connection?.status, onConnectionStatusChange]);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;

    const tick = async () => {
      const [conn, jobResult, deviceResult] = await Promise.all([
        getFbrConnectionAction(draftId),
        getLocalAgentJobsAction(draftId),
        getTrustedDevicesAction(draftId),
      ]);
      if (cancelled) return;
      if (conn.success) setConnection(conn.connection);
      if (jobResult.success && jobResult.jobs) {
        setJobs(jobResult.jobs as JobView[]);
      }
      if (deviceResult.success && deviceResult.devices) {
        setDevices(deviceResult.devices as DeviceView[]);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [draftId]);

  async function refreshJobs() {
    if (!draftId) return;
    const result = await getLocalAgentJobsAction(draftId);
    if (result.success && result.jobs) {
      setJobs(result.jobs as JobView[]);
    }
  }

  async function refreshConnection() {
    if (!draftId) return;
    const result = await getFbrConnectionAction(draftId);
    if (result.success) {
      setConnection(result.connection);
    }
  }

  async function refreshDevices() {
    const result = await getTrustedDevicesAction(draftId);
    if (result.success && result.devices) {
      setDevices(result.devices as DeviceView[]);
    }
  }

  async function handleCreateSession() {
    if (!draftId) return;
    setSessionLoading(true);
    setError(null);
    try {
      await startFbrConnectionAction(draftId);
      const res = await fetch("/api/fbr-connect/desktop/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingDraftId: draftId }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Could not start the desktop agent");
      } else {
        setSession(data.session);
        try {
          await fetch(data.session.localhostUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              flow: "fbr",
              token: data.session.launchToken,
              partitionKey: data.session.partitionKey,
              apiBaseUrl: window.location.origin,
            }),
          });
        } catch {
          // Installed app opens via deep link.
        }
        window.location.href = data.session.deepLink;
      }
    } catch {
      setError("Could not start the desktop agent");
    }
    setSessionLoading(false);
    void refreshDevices();
    void refreshConnection();
  }

  async function handleStartFiling() {
    if (!draftId) return;
    setActionLoading("assisted");
    setError(null);
    const result = await queueAssistedFilingJobAction(draftId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not start filing");
    } else {
      setStartOver(false);
      void refreshJobs();
    }
  }

  async function handleCancelJob(jobId: string) {
    setActionLoading(jobId);
    const result = await cancelJobAction(jobId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not cancel");
    } else {
      void refreshJobs();
    }
  }

  async function handleResumeJob(jobId: string, finalSubmitConfirmed = false) {
    setActionLoading(jobId);
    const result = await resumeJobAfterPauseAction(jobId, {
      resumedAt: new Date().toISOString(),
      confirmedBy: "user",
      ...(finalSubmitConfirmed ? { finalSubmitConfirmed: true } : {}),
    });
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Could not continue");
    } else {
      void refreshJobs();
    }
  }

  const readyDevice = devices
    .filter(
      (d) =>
        d.status === "ACTIVE" &&
        d.lastSeenAt &&
        Date.now() - new Date(d.lastSeenAt).getTime() <
          AGENT_HEARTBEAT_FRESH_MS,
    )
    .sort((a, b) => {
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bt - at;
    })[0];
  const sessionFresh =
    Boolean(session) &&
    Date.now() - (new Date(session!.expiresAt).getTime() - SESSION_TTL_MS) <
      SESSION_GRACE_MS;
  const agentReady = Boolean(readyDevice || sessionFresh);
  const activeJob = jobs.find((j) => ACTIVE_JOB_STATUSES.has(j.status));
  const completedFiling = jobs.find(
    (j) => j.jobType !== "tax_dry_run" && j.status === "completed",
  );

  let phase: Phase = "connect";
  if (activeJob?.status === "awaiting_user_action") phase = "resume";
  else if (activeJob) phase = "working";
  else if (completedFiling && agentReady && !startOver) phase = "done";
  else if (agentReady) phase = "start";

  const activeFlowStep = flowStepForPhase(phase);
  const activeIndex = FLOW_ORDER.indexOf(activeFlowStep);

  // A fresh pause (or a fresh job) always reopens the gate: "Not now" must
  // never carry over to a later submit question.
  useEffect(() => {
    setSubmitGateOpen(true);
  }, [activeJob?.id, activeJob?.pauseAction]);

  return (
    <div className="space-y-5">
      <ol className="grid gap-2 text-xs sm:grid-cols-3">
        {FLOW_STEPS.map((step) => {
          const stepIndex = FLOW_ORDER.indexOf(step.id);
          const isDone = phase === "done" || stepIndex < activeIndex;
          const isCurrent = !isDone && step.id === activeFlowStep;
          return (
            <li
              key={step.id}
              className={`rounded-lg border px-3 py-2 ${chipClass(isDone, isCurrent)}`}
            >
              <span className="font-medium">
                {step.n}. {step.label}
              </span>
            </li>
          );
        })}
      </ol>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {phase === "connect" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Monitor className="h-4 w-4" /> Step 1 — Install the desktop agent
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Filing runs on this computer. Download the Tax Rocket Portal
              Agent, install it, then confirm below.
            </p>
            <Button asChild size="sm" className="gap-2">
              <a href="/api/downloads/taxrocket-agent/windows">
                <Download className="h-3.5 w-3.5" /> Download for Windows
              </a>
            </Button>
            <label className="flex cursor-pointer items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-amanah"
                checked={installedAck}
                onChange={(event) => setInstalledAck(event.target.checked)}
              />
              <span>
                I already installed this app
                {installedAck ? (
                  <CheckCircle className="ml-1 inline h-3.5 w-3.5 text-green-600" />
                ) : null}
              </span>
            </label>
            <Button
              size="sm"
              disabled={!draftId || !installedAck || sessionLoading}
              onClick={handleCreateSession}
              className="gap-2"
            >
              {sessionLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Monitor className="h-3.5 w-3.5" />
              )}
              Open Desktop Agent
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "start" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="h-4 w-4" /> Step 2 — Start filing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Agent is ready
              {readyDevice?.deviceName ? ` on ${readyDevice.deviceName}` : ""}.
              This fills your return in IRIS and pauses when a password reset,
              OTP, PIN, or payment is needed.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!draftId || !!actionLoading}
                onClick={handleStartFiling}
                className="gap-2"
              >
                {actionLoading === "assisted" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Start filing
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={sessionLoading}
                onClick={handleCreateSession}
                className="gap-2"
              >
                {sessionLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Monitor className="h-3.5 w-3.5" />
                )}
                Reconnect agent
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Agent window closed or IRIS needs to be reopened? &quot;Reconnect
              agent&quot; creates a fresh secure session and launches the
              desktop agent again.
            </p>
          </CardContent>
        </Card>
      )}

      {phase === "working" && activeJob && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Filing in progress
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Look at the Tax Rocket Portal Agent window. Do not start another
              filing. If a password, OTP, PIN, or payment appears, complete it
              there — this page will then ask you to continue.
            </p>
            <p className="text-xs text-muted-foreground">
              Assisted filing · started {formatWhen(activeJob.createdAt)}
            </p>
            <Button
              size="sm"
              variant="ghost"
              disabled={actionLoading === activeJob.id}
              onClick={() => handleCancelJob(activeJob.id)}
            >
              Cancel this filing
            </Button>
          </CardContent>
        </Card>
      )}

      {phase === "resume" &&
        activeJob &&
        isFinalSubmitPause(activeJob.pauseAction) &&
        submitGateOpen && (
          <Card data-testid="final-submit-gate" className="border-red-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-red-800">
                <ShieldCheck className="h-4 w-4" /> Final gate — Submit this
                return to FBR?
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                The agent has filled your return in IRIS and is waiting at the
                final submit step. Nothing is submitted until you choose.
              </p>
              {(taxPayable != null ||
                refundDue != null ||
                packetVersion != null) && (
                <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {packetVersion != null && (
                    <p>Packet version: v{packetVersion}</p>
                  )}
                  {taxPayable != null && (
                    <p>
                      Tax payable: PKR {Math.round(taxPayable).toLocaleString()}
                    </p>
                  )}
                  {refundDue != null && (
                    <p>
                      Refund due: PKR {Math.round(refundDue).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
              <p className="text-xs font-medium text-red-800">
                Submitting is final in IRIS. Choose only after reviewing the
                figures above.
              </p>
              {activeJob.pauseMessage && (
                <p className="text-muted-foreground">
                  {activeJob.pauseMessage}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  data-testid="final-submit-yes"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => handleResumeJob(activeJob.id, true)}
                  className="gap-2"
                >
                  {actionLoading === activeJob.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle className="h-3.5 w-3.5" />
                  )}
                  Yes, submit to FBR
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="final-submit-no"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => setSubmitGateOpen(false)}
                >
                  Not now
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actionLoading === activeJob.id}
                  onClick={() => handleCancelJob(activeJob.id)}
                >
                  Cancel this filing
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      {phase === "resume" &&
        activeJob &&
        isFinalSubmitPause(activeJob.pauseAction) &&
        !submitGateOpen && (
          <Card className="border-amber-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-amber-800">
                <CheckCircle className="h-4 w-4" /> Submission waiting
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                The return is still waiting at the final submit step. Nothing
                has been submitted.
              </p>
              <Button size="sm" onClick={() => setSubmitGateOpen(true)}>
                Review the submit gate
              </Button>
            </CardContent>
          </Card>
        )}

      {phase === "resume" &&
        activeJob &&
        !isFinalSubmitPause(activeJob.pauseAction) && (
          <Card className="border-amber-200">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm text-amber-800">
                <CheckCircle className="h-4 w-4" /> Step 3 — Continue
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>
                {PAUSE_LABELS[activeJob.pauseAction || ""] ??
                  "Action needed in the desktop agent"}
              </p>
              {activeJob.pauseMessage && (
                <p className="text-muted-foreground">
                  {activeJob.pauseMessage}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Finish that step in the agent window, then press Continue here.
              </p>
              <Button
                size="sm"
                disabled={actionLoading === activeJob.id}
                onClick={() => handleResumeJob(activeJob.id)}
                className="gap-2"
              >
                {actionLoading === activeJob.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                Continue
              </Button>
            </CardContent>
          </Card>
        )}

      {phase === "done" && (
        <Card className="border-green-200 bg-green-50/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-green-800">
              <CheckCircle className="h-4 w-4" /> Filing finished
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Assisted filing completed
              {completedFiling
                ? ` at ${formatWhen(
                    completedFiling.completedAt || completedFiling.createdAt,
                  )}`
                : ""}
              .
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setStartOver(true);
                setError(null);
              }}
            >
              File again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
