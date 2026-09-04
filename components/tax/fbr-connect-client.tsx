"use client";

import { useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  ShieldCheck,
  Download,
  Play,
  CheckCircle,
  AlertCircle,
  Clock,
  Monitor,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
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
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type DeviceView = {
  id: string;
  deviceName: string | null;
  partitionKey: string;
  status: string;
  localFbrConnectedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  WAITING_FOR_AGENT: "Waiting for local agent",
  AGENT_CONNECTED: "Agent connected - Ready",
  DRY_RUN_QUEUED: "Dry run queued",
  FILING_QUEUED: "Filing queued",
  DRY_RUN_COMPLETED: "Dry run completed",
  FILING_COMPLETED: "Filing completed",
  CONNECTED: "Agent connected",
  RUNNING: "Filing in progress",
  COMPLETED: "Filing completed",
  FAILED: "Failed",
};

export default function FbrConnectClient({
  draftId,
  initialConnection,
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
    if (draftId) {
      refreshJobs();
      refreshDevices();
    }
  }, [draftId]);

  async function refreshJobs() {
    if (!draftId) return;
    const result = await getLocalAgentJobsAction(draftId);
    if (result.success && result.jobs) {
      setJobs(result.jobs as any);
    }
  }

  async function refreshDevices() {
    const result = await getTrustedDevicesAction(draftId);
    if (result.success && result.devices) {
      setDevices(result.devices as any);
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
        // Try localhost bridge with FBR flow (fix for DLD vs FBR)
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
        } catch (e) {
          console.log("Bridge POST failed, will try deep link", e);
          // Fallback to deep link with flow=fbr
          // window.location.href = data.session.deepLink;
        }
      }
    } catch (e) {
      setError("Failed to create desktop session");
    }
    setSessionLoading(false);
    refreshDevices();
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
      refreshJobs();
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
      refreshJobs();
    }
  }

  async function handleCancelJob(jobId: string) {
    setActionLoading(jobId);
    const result = await cancelJobAction(jobId);
    setActionLoading(null);
    if (!result.success) {
      setError(result.error || "Failed to cancel");
    } else {
      refreshJobs();
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
      refreshJobs();
    }
  }

  const status = connection?.status ?? "NOT_STARTED";
  const isWaiting = status === "WAITING_FOR_AGENT";
  const isAgentConnected =
    status === "AGENT_CONNECTED" ||
    status === "DRY_RUN_QUEUED" ||
    status === "FILING_QUEUED" ||
    status === "DRY_RUN_COMPLETED";
  const hasActiveJob = jobs.some((j) =>
    [
      "created",
      "offered_to_device",
      "accepted_by_device",
      "running",
      "awaiting_user_action",
    ].includes(j.status),
  );

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-6 text-center">
        <ShieldCheck className="h-6 w-6 text-amanah" />
        <p className="text-sm font-medium">
          Local Trusted Desktop Agent connection
        </p>
        <p className="text-xs text-muted-foreground">
          Status: {STATUS_LABELS[status] ?? status}
        </p>
        {connection?.message && (
          <p className="max-w-md text-xs text-muted-foreground">
            {connection.message}
          </p>
        )}
        {(error || connection?.errorMessage) && (
          <p className="text-xs text-destructive">
            {error ?? connection?.errorMessage}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!draftId || starting || isWaiting}
            onClick={handleStart}
            className="gap-2"
          >
            {starting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ExternalLink className="h-3.5 w-3.5" />
            )}
            {starting
              ? "Starting..."
              : isWaiting
                ? "Waiting for Agent"
                : "Init Connection"}
          </Button>

          <Button
            type="button"
            variant="outline"
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
            Create Desktop Session
          </Button>
        </div>

        {session && (
          <Card className="mt-4 w-full text-left">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Desktop Session Created</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div>
                <p className="font-medium">Partition:</p>
                <code className="rounded bg-muted px-1 py-0.5 text-[11px]">
                  {session.partitionKey}
                </code>
              </div>
              <div>
                <p className="font-medium">Expires:</p>
                <p>{new Date(session.expiresAt).toLocaleString()}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Button
                  size="sm"
                  onClick={() => (window.location.href = session.deepLink)}
                  className="gap-2"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open Desktop App
                  (Deep Link)
                </Button>
                <a
                  href={session.localhostUrl}
                  target="_blank"
                  className="text-center text-[11px] text-muted-foreground underline"
                >
                  Or try localhost bridge: {session.localhostUrl}
                </a>
                <div className="rounded bg-amber-50 p-2 text-[11px] text-amber-800">
                  <p className="font-medium">Manual:</p>
                  <p>
                    Copy token:{" "}
                    <code className="bg-white px-1">
                      {session.launchToken.slice(0, 16)}...
                    </code>
                  </p>
                  <p>Open TaxRocket Agent app and paste token</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Trusted Devices */}
      {devices.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Monitor className="h-4 w-4" /> Trusted Devices ({devices.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded border p-2 text-xs"
              >
                <div>
                  <p className="font-medium">
                    {d.deviceName || "Desktop Agent"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {d.partitionKey} • {d.status}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Last seen:{" "}
                    {d.lastSeenAt
                      ? new Date(d.lastSeenAt).toLocaleString()
                      : "never"}{" "}
                    {d.localFbrConnectedAt ? "• FBR Ready" : ""}
                  </p>
                </div>
                <div
                  className={`h-2 w-2 rounded-full ${d.status === "ACTIVE" ? "bg-green-500" : d.status === "PENDING" ? "bg-yellow-500" : "bg-gray-400"}`}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Job Queue Actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Filing Jobs</CardTitle>
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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={refreshJobs}
              className="gap-2"
            >
              <Clock className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Dry Run = fill fields, stop at final review, no submit. Assisted
            Filing = supervised with OTP/PIN/PSID pauses. Complete dry run
            first.
          </p>

          {jobs.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              No jobs queued yet
            </p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="rounded border p-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium flex items-center gap-1.5">
                        {job.jobType === "tax_dry_run" ? (
                          <Play className="h-3 w-3" />
                        ) : (
                          <ShieldCheck className="h-3 w-3" />
                        )}
                        {job.jobType === "tax_dry_run"
                          ? "Dry Run"
                          : "Assisted Filing"}
                        <span
                          className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${job.status === "completed" ? "bg-green-100 text-green-700" : job.status === "failed" ? "bg-red-100 text-red-700" : job.status === "awaiting_user_action" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"}`}
                        >
                          {job.status}
                        </span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Created: {new Date(job.createdAt).toLocaleString()}
                      </p>
                      {job.pauseAction && (
                        <div className="mt-1 rounded bg-amber-50 p-1.5 text-amber-800">
                          <p className="font-medium">
                            Paused: {job.pauseAction}
                          </p>
                          {job.pauseMessage && (
                            <p className="text-[11px]">{job.pauseMessage}</p>
                          )}
                          <p className="text-[10px] mt-1">
                            Action required in IRIS (OTP/Captcha/PIN/PSID).
                            Complete in Desktop Agent, then resume.
                          </p>
                        </div>
                      )}
                      {job.errorMessage && (
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
                      {[
                        "created",
                        "offered_to_device",
                        "accepted_by_device",
                        "running",
                        "awaiting_user_action",
                      ].includes(job.status) && (
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

      {/* Download Agent */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Download className="h-4 w-4" /> Download Desktop Agent
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <p className="text-muted-foreground">
            Windows app that runs FBR IRIS locally in a secure partition. Keeps
            OTP/PIN local.
          </p>
          <div className="flex gap-2">
            <Button asChild size="sm" variant="outline" className="gap-2">
              <a href="/api/downloads/taxrocket-agent/windows" target="_blank">
                <Download className="h-3.5 w-3.5" /> Download for Windows (.exe)
              </a>
            </Button>
            <Button asChild size="sm" variant="ghost" className="text-[11px]">
              <a href="/api/downloads/dld-connection/windows" target="_blank">
                Legacy endpoint (dld-connection)
              </a>
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Version: portal-agent v1.0 • Requires Windows 10+ • Electron
          </p>
          <div className="rounded bg-muted p-2 text-[11px]">
            <p className="font-medium">Dev (without installer):</p>
            <code>npm run desktop-connect:dev</code> in electron-connect folder
          </div>
        </CardContent>
      </Card>

      {/* Info about portalFieldMap */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="p-3 text-[11px] text-blue-900">
          <p className="font-medium">Portal Field Map Ready</p>
          <p>
            Packet now includes IRIS system codes (e.g., 1000 Salary, 2001 Rent,
            500312 Profit on Debt, 64150301 236C, 64151101 236K) from
            IRIS_System_Field_Codes_Extracted.csv. Electron agent uses these to
            auto-fill IRIS fields.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
