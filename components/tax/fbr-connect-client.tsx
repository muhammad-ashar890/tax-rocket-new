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
  queueDryRunJobAction,
  queueAssistedFilingJobAction,
  getLocalAgentJobsAction,
  cancelJobAction,
  resumeJobAfterPauseAction,
  getTrustedDevicesAction,
} from "@/app/actions/fbr-jobs";

type Props = {
  draftId?: string;
  initialConnection: FbrConnectionView | null;
  onConnectionStatusChange?: (status: string) => void;
};

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

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  WAITING_FOR_AGENT: "Waiting for desktop agent",
  AGENT_CONNECTED: "Agent ready",
  DRY_RUN_QUEUED: "Dry run queued",
  FILING_QUEUED: "Filing queued",
  DRY_RUN_COMPLETED: "Dry run completed",
  FILING_COMPLETED: "Filing completed",
  CONNECTED: "Agent ready",
  RUNNING: "Filing in progress",
  COMPLETED: "Filing completed",
  FAILED: "Failed",
};

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

const JOB_STATUS_LABELS: Record<string, string> = {
  created: "Queued",
  offered_to_device: "Sent to agent",
  accepted_by_device: "Accepted",
  running: "Running",
  awaiting_user_action: "Action needed",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const ACTIVE_JOB_STATUSES = [
  "created",
  "offered_to_device",
  "accepted_by_device",
  "running",
  "awaiting_user_action",
];

function formatWhen(value: string | Date | null | undefined) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

export default function FbrConnectClient({
  draftId,
  initialConnection,
  onConnectionStatusChange,
}: Props) {
  const [connection, setConnection] = useState(initialConnection);
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<DesktopSession | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  useEffect(() => {
    onConnectionStatusChange?.(connection?.status ?? "NOT_STARTED");
  }, [connection?.status, onConnectionStatusChange]);

  useEffect(() => {
    if (!draftId) return;

    const tick = () => {
      void refreshJobs();
      void refreshConnection();
      void refreshDevices();
    };

    tick();
    const timer = window.setInterval(tick, 2500);
    return () => window.clearInterval(timer);
  }, [draftId]);

  async function refreshConnection() {
    if (!draftId) return;
    const result = await getFbrConnectionAction(draftId);
    if (result.success) {
      setConnection(result.connection);
    }
  }

  async function refreshJobs() {
    if (!draftId) return;
    const result = await getLocalAgentJobsAction(draftId);
    if (result.success && result.jobs) {
      setJobs(result.jobs as JobView[]);
    }
  }

  async function refreshDevices() {
    const result = await getTrustedDevicesAction(draftId);
    if (result.success && result.devices) {
      setDevices(result.devices as DeviceView[]);
    }
  }

  async function handleStart() {
    if (!draftId) return;
    setStarting(true);
    setError(null);
    const result = await startFbrConnectionAction(draftId);
    setStarting(false);
    if (!result.success) {
      setError(result.error ?? "Failed to start");
      return;
    }
    setConnection(result.connection);
  }

  async function handleCreateSession() {
    if (!draftId) return;
    setSessionLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/fbr-connect/desktop/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filingDraftId: draftId }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || "Failed to create session");
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
          // Installed agent is opened via deep link below.
        }
      }
    } catch {
      setError("Failed to create desktop session");
    }
    setSessionLoading(false);
    void refreshDevices();
  }

  async function handleQueueDryRun() {
    if (!draftId) return;
    setActionLoading("dry_run");
    setError(null);
    const result = await queueDryRunJobAction(draftId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Failed to queue dry run");
    } else {
      void refreshJobs();
    }
  }

  async function handleQueueAssisted() {
    if (!draftId) return;
    setActionLoading("assisted");
    setError(null);
    const result = await queueAssistedFilingJobAction(draftId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Failed to queue assisted filing");
    } else {
      void refreshJobs();
    }
  }

  async function handleCancelJob(jobId: string) {
    setActionLoading(jobId);
    const result = await cancelJobAction(jobId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Failed to cancel");
    } else {
      void refreshJobs();
    }
  }

  async function handleResumeJob(jobId: string) {
    setActionLoading(jobId);
    const result = await resumeJobAfterPauseAction(jobId, {
      resumedAt: new Date().toISOString(),
      confirmedBy: "user",
    });
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Failed to resume");
    } else {
      void refreshJobs();
    }
  }

  const status = connection?.status ?? "NOT_STARTED";
  const showStaleError =
    Boolean(error) ||
    (Boolean(connection?.errorMessage) && status === "FAILED");
  const hasActiveJob = jobs.some((j) => ACTIVE_JOB_STATUSES.includes(j.status));
  const readyDevices = devices
    .filter((d) => d.status === "ACTIVE")
    .sort((a, b) => {
      const at = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const bt = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
      return bt - at;
    })
    .slice(0, 3);
  const visibleJobs = jobs.slice(0, 6);

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center">
        <ShieldCheck className="h-6 w-6 text-amanah" />
        <p className="text-sm font-medium">Desktop agent</p>
        <p className="text-xs text-muted-foreground">
          {STATUS_LABELS[status] ?? status}
        </p>
        {connection?.message && status !== "FAILED" && (
          <p className="max-w-md text-xs text-muted-foreground">
            {connection.message}
          </p>
        )}
        {showStaleError && (
          <p className="text-xs text-destructive">
            {error ?? connection?.errorMessage}
          </p>
        )}

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={!draftId || sessionLoading}
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!draftId || starting}
            onClick={handleStart}
            className="gap-2"
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            Prepare connection
          </Button>
        </div>

        {session && (
          <div className="mt-2 w-full rounded-lg border bg-muted/40 p-3 text-left text-xs">
            <p className="font-medium">Agent session is ready</p>
            <p className="mt-1 text-muted-foreground">
              If the app did not open, click the button below. Session expires{" "}
              {formatWhen(session.expiresAt)}.
            </p>
            <Button
              size="sm"
              className="mt-3 gap-2"
              onClick={() => {
                window.location.href = session.deepLink;
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" /> Open Tax Rocket Portal
              Agent
            </Button>
          </div>
        )}
      </div>

      {readyDevices.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Monitor className="h-4 w-4" /> This computer
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {readyDevices.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded border p-2 text-xs"
              >
                <div>
                  <p className="font-medium">
                    {d.deviceName || "Desktop Agent"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {d.localFbrConnectedAt ? "Ready for Iris" : "Connected"}
                    {d.lastSeenAt ? ` · Last seen ${formatWhen(d.lastSeenAt)}` : ""}
                  </p>
                </div>
                <div className="h-2 w-2 rounded-full bg-green-500" />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!draftId || hasActiveJob || !!actionLoading}
              onClick={handleQueueDryRun}
              className="gap-2"
            >
              {actionLoading === "dry_run" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Queue Dry Run
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!draftId || hasActiveJob || !!actionLoading}
              onClick={handleQueueAssisted}
              className="gap-2"
            >
              {actionLoading === "assisted" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}
              Queue Assisted Filing
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Dry run fills the return and stops before submit. Assisted filing
            pauses for OTP, PIN, and PSID — press Resume after each step.
          </p>

          {visibleJobs.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No filing jobs yet
            </p>
          ) : (
            <div className="space-y-2">
              {visibleJobs.map((job) => (
                <div key={job.id} className="rounded border p-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="flex items-center gap-1.5 font-medium">
                        {job.jobType === "tax_dry_run" ? (
                          <Play className="h-3 w-3" />
                        ) : (
                          <ShieldCheck className="h-3 w-3" />
                        )}
                        {job.jobType === "tax_dry_run"
                          ? "Dry Run"
                          : "Assisted Filing"}
                        <span
                          className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                            job.status === "completed"
                              ? "bg-green-100 text-green-700"
                              : job.status === "failed"
                                ? "bg-red-100 text-red-700"
                                : job.status === "awaiting_user_action"
                                  ? "bg-amber-100 text-amber-700"
                                  : job.status === "cancelled"
                                    ? "bg-muted text-muted-foreground"
                                    : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {JOB_STATUS_LABELS[job.status] ?? job.status}
                        </span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {formatWhen(job.createdAt)}
                      </p>
                      {job.pauseAction &&
                        job.status === "awaiting_user_action" && (
                          <div className="mt-1 rounded bg-amber-50 p-1.5 text-amber-800">
                            <p className="font-medium">
                              {PAUSE_LABELS[job.pauseAction] ?? job.pauseAction}
                            </p>
                            {job.pauseMessage && (
                              <p className="text-[11px]">{job.pauseMessage}</p>
                            )}
                          </div>
                        )}
                      {job.status === "failed" && job.errorMessage && (
                        <p className="mt-1 text-[11px] text-red-600">
                          {job.errorMessage}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col gap-1">
                      {job.status === "awaiting_user_action" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          disabled={actionLoading === job.id}
                          onClick={() => handleResumeJob(job.id)}
                        >
                          {actionLoading === job.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle className="h-3 w-3" />
                          )}
                          Resume
                        </Button>
                      )}
                      {ACTIVE_JOB_STATUSES.includes(job.status) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[11px]"
                          disabled={actionLoading === job.id}
                          onClick={() => handleCancelJob(job.id)}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" /> Desktop Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Install once on this Windows PC. OTP and PIN never leave the
            machine.
          </p>
          <Button asChild size="sm" variant="outline" className="gap-2">
            <a href="/api/downloads/taxrocket-agent/windows">
              <Download className="h-3.5 w-3.5" /> Download for Windows
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
