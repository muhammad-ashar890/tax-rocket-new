"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, CheckCircle2, LaptopMinimal, Play, RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

type LaunchResponse =
  | {
      ok: true;
      token: string;
      launchNonce: string;
      apiBaseUrl: string;
      partitionKey: string;
      desktopAuthConfig: {
        loginUrl: string;
        readySelector: string;
        readyRejectSelector: string | null;
        readyUrlPattern: string | null;
        useMockIris: boolean;
      };
      allowedOrigins: string[];
      backendAllowlist: string[];
      localBridgeUrl: string;
      launchUrl: string;
    }
  | {
      error: string;
    };

type FbrConnectClientProps = {
  installer: {
    available: boolean;
    downloadPath: string;
    platformLabel: string;
  };
  draftId: string | null;
  deviceReady: boolean;
  deviceDisplayName: string | null;
  dryRunReady: boolean;
  dryRunReasons: string[];
  assistedReady: boolean;
  assistedReasons: string[];
  jobs: Array<{
    id: string;
    publicId: string;
    type: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    trustedDevice: { publicId: string; displayName: string };
    result: Record<string, unknown> | null;
    executionLog: Array<Record<string, unknown>> | null;
  }>;
};

function getJobTone(status: string) {
  switch (status) {
    case "completed":
      return "border-primary/25 bg-primary/10 text-primary";
    case "failed":
    case "cancelled":
      return "border-destructive/25 bg-destructive/10 text-destructive";
    case "running":
    case "awaiting_user_action":
      return "border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]";
    default:
      return "border-border bg-background text-muted-foreground";
  }
}

export function FbrConnectClient(props: FbrConnectClientProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [isLaunchingDesktop, startDesktopLaunch] = useTransition();
  const [isQueuingDryRun, startDryRunQueue] = useTransition();
  const [isQueuingAssisted, startAssistedQueue] = useTransition();
  const [isConfirmingStep, startStepConfirm] = useTransition();
  const [desktopMessage, setDesktopMessage] = useState("");

  const latestJob = props.jobs[0] ?? null;
  const screenshotCaptures = useMemo(() => {
    const captures = latestJob?.result?.captures;
    return Array.isArray(captures) ? captures : [];
  }, [latestJob]);
  const latestRequiredAction =
    latestJob?.result && typeof latestJob.result.requiredAction === "string"
      ? latestJob.result.requiredAction
      : null;
  const latestRecoveryActions = Array.isArray(latestJob?.result?.recoveryActions)
    ? latestJob.result.recoveryActions
    : [];

  const handleDesktopLaunch = () => {
    startDesktopLaunch(async () => {
      setDesktopMessage("");

      try {
        const response = await fetch("/api/fbr-connect/desktop/session", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        const payload = (await response.json().catch(() => null)) as LaunchResponse | null;

        if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
          throw new Error(
            payload && "error" in payload && payload.error
              ? payload.error
              : "The desktop launch could not be started.",
          );
        }

        setDesktopMessage(
          "Desktop request sent. Complete local Iris sign-in there and come back once the trusted device shows ready.",
        );

        let bridgeAccepted = false;

        try {
          const bridgeResponse = await fetch(payload.localBridgeUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              flow: "fbr",
              token: payload.token,
              nonce: payload.launchNonce,
              apiBaseUrl: payload.apiBaseUrl,
              partitionKey: payload.partitionKey,
              allowedOrigins: payload.allowedOrigins,
              backendAllowlist: payload.backendAllowlist,
              desktopAuthConfig: payload.desktopAuthConfig,
            }),
          });

          bridgeAccepted = bridgeResponse.ok;
        } catch {
          bridgeAccepted = false;
        }

        if (!bridgeAccepted) {
          window.location.href = payload.launchUrl;
        }

        toast({
          title: "Desktop launch sent",
          description: "Accept the launch in the desktop app and finish the local Iris sign-in there.",
        });
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Desktop launch failed",
          description:
            error instanceof Error ? error.message : "The desktop agent could not be opened.",
        });
      }
    });
  };

  const handleQueueDryRun = () => {
    if (!props.draftId) {
      return;
    }

    startDryRunQueue(async () => {
      try {
        const response = await fetch("/api/local-agent/tax/dry-run", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            draftId: props.draftId,
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { ok: true; job: { publicId: string } }
          | { error: string }
          | null;

        if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
          throw new Error(
            payload && "error" in payload && payload.error
              ? payload.error
              : "The dry-run job could not be queued.",
          );
        }

        toast({
          title: "Dry run queued",
          description: `Job ${payload.job.publicId} is waiting for the trusted desktop agent.`,
        });
        router.refresh();
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Dry run blocked",
          description:
            error instanceof Error ? error.message : "The dry-run job could not be created.",
        });
      }
    });
  };

  const handleQueueAssisted = () => {
    if (!props.draftId) {
      return;
    }

    startAssistedQueue(async () => {
      try {
        const response = await fetch("/api/local-agent/tax/assisted-filing", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            draftId: props.draftId,
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { ok: true; job: { publicId: string } }
          | { error: string }
          | null;

        if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
          throw new Error(
            payload && "error" in payload && payload.error
              ? payload.error
              : "The assisted filing pilot could not be queued.",
          );
        }

        toast({
          title: "Assisted filing queued",
          description: `Pilot job ${payload.job.publicId} is waiting for the trusted desktop agent.`,
        });
        router.refresh();
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Pilot launch blocked",
          description:
            error instanceof Error ? error.message : "The assisted filing pilot could not be created.",
        });
      }
    });
  };

  const handleConfirmStep = (action: string) => {
    if (!latestJob) {
      return;
    }

    startStepConfirm(async () => {
      try {
        const response = await fetch("/api/local-agent/tax/confirm-step", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jobId: latestJob.id,
            action,
          }),
        });

        const payload = (await response.json().catch(() => null)) as
          | { ok: true }
          | { error: string }
          | null;

        if (!response.ok || !payload || !("ok" in payload) || !payload.ok) {
          throw new Error(
            payload && "error" in payload && payload.error
              ? payload.error
              : "The assisted filing step could not be confirmed.",
          );
        }

        toast({
          title: "Step confirmed",
          description: "The desktop agent can continue from the next supervised step.",
        });
        router.refresh();
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Confirmation failed",
          description:
            error instanceof Error ? error.message : "The local agent could not be resumed.",
        });
      }
    });
  };

  return (
    <div className="space-y-6">
      <Card className={props.deviceReady ? "border-primary/25" : "border-[#B8872F]/35"}>
        <CardHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <LaptopMinimal className="h-5 w-5" />
          </div>
          <CardTitle>Trusted desktop device</CardTitle>
          <CardDescription>
            Tax Rocket keeps Iris login local to the desktop app. Dry runs and later assisted filing
            only use a trusted device and an approved packet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={props.deviceReady ? "border-primary/25 bg-primary/10 text-primary" : "border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"}>
              {props.deviceReady ? "Ready for Iris dry run" : "Desktop connection needed"}
            </Badge>
            {props.deviceDisplayName ? <Badge variant="outline">{props.deviceDisplayName}</Badge> : null}
          </div>

          <p className="text-sm text-muted-foreground">
            The desktop app stores the trusted-device token locally, validates the Iris session on
            that device, and never clicks final submit in dry-run mode.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button onClick={handleDesktopLaunch} disabled={isLaunchingDesktop}>
              {isLaunchingDesktop ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
              Open Desktop Agent
            </Button>
            {props.installer.available ? (
              <Button asChild variant="outline">
                <a href={props.installer.downloadPath}>
                  Download {props.installer.platformLabel} App
                </a>
              </Button>
            ) : null}
          </div>

          {desktopMessage ? (
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary">
              {desktopMessage}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className={props.dryRunReady ? "border-primary/25" : "border-[#B8872F]/35"}>
        <CardHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-[#0E7490]/10 text-[#0E7490]">
            <Bot className="h-5 w-5" />
          </div>
          <CardTitle>Mode 1 dry run</CardTitle>
          <CardDescription>
            This uses the approved packet to fill the mock or configured Iris flow locally, captures
            status and screenshots, then stops at the final review gate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={props.dryRunReady ? "border-primary/25 bg-primary/10 text-primary" : "border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"}>
              {props.dryRunReady ? "Approved packet ready" : "Dry run still blocked"}
            </Badge>
            {props.draftId ? <Badge variant="outline">Draft {props.draftId.slice(0, 10)}...</Badge> : null}
          </div>

          {props.dryRunReasons.length ? (
            <div className="space-y-2">
              {props.dryRunReasons.map((reason) => (
                <div key={reason} className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                  {reason}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary">
              The current approval, packet version/hash, and reconciliation state are aligned for a dry run.
            </div>
          )}

          <Button onClick={handleQueueDryRun} disabled={!props.dryRunReady || !props.deviceReady || isQueuingDryRun || !props.draftId}>
            {isQueuingDryRun ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Queue Dry Run
          </Button>
        </CardContent>
      </Card>

      <Card className={props.assistedReady ? "border-primary/25" : "border-[#B8872F]/35"}>
        <CardHeader>
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <CardTitle>Mode 1 controlled assisted filing pilot</CardTitle>
          <CardDescription>
            This supervised pilot uses the same approved packet, but pauses at password reset,
            OTP/captcha/PIN, PSID/payment, and final-submit confirmation so the user stays in command.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={props.assistedReady ? "border-primary/25 bg-primary/10 text-primary" : "border-[#B8872F]/35 bg-[#B8872F]/10 text-[#8A641F]"}>
              {props.assistedReady ? "Pilot case ready" : "Pilot still blocked"}
            </Badge>
            <Badge variant="outline">Simple / supervised Mode 1 only</Badge>
          </div>

          {props.assistedReasons.length ? (
            <div className="space-y-2">
              {props.assistedReasons.map((reason) => (
                <div key={reason} className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                  {reason}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3 text-sm text-primary">
              This filing is inside the supervised Mode 1 pilot gate and can pause through each live portal checkpoint.
            </div>
          )}

          <Button onClick={handleQueueAssisted} disabled={!props.assistedReady || !props.deviceReady || isQueuingAssisted || !props.draftId}>
            {isQueuingAssisted ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
            Queue Assisted Filing Pilot
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Latest dry-run result</CardTitle>
          <CardDescription>
            Screenshots and status come back from the desktop agent so we can prove where the dry run stopped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!latestJob ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
              No dry-run job yet.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{latestJob.publicId}</Badge>
                <Badge variant="outline">{latestJob.type.replaceAll("_", " ")}</Badge>
                <Badge variant="outline" className={getJobTone(latestJob.status)}>
                  {latestJob.status.replaceAll("_", " ")}
                </Badge>
                <Badge variant="outline">{latestJob.trustedDevice.displayName}</Badge>
              </div>

              {latestJob.result?.message ? (
                <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                  {String(latestJob.result.message)}
                </div>
              ) : null}

              {latestJob.result?.pauseReason ? (
                <div className="rounded-lg border border-[#B8872F]/35 bg-[#B8872F]/10 px-4 py-3 text-sm text-[#8A641F]">
                  {String(latestJob.result.pauseReason)}
                </div>
              ) : null}

              {latestRequiredAction && latestJob.status === "awaiting_user_action" ? (
                <div className="rounded-lg border border-[#0E7490]/25 bg-[#0E7490]/10 px-4 py-4 text-sm text-[#0E7490]">
                  <div className="font-medium text-foreground">Human confirmation required</div>
                  <div className="mt-1">
                    {String(
                      latestJob.result?.userInstruction ||
                        "Finish the required step locally, then confirm here so the desktop agent can continue.",
                    )}
                  </div>
                  <Button
                    className="mt-3"
                    onClick={() => handleConfirmStep(latestRequiredAction)}
                    disabled={isConfirmingStep}
                  >
                    {isConfirmingStep ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}
                    I completed this locally, continue
                  </Button>
                </div>
              ) : null}

              {latestRecoveryActions.length ? (
                <div className="space-y-2">
                  {latestRecoveryActions.map((action, index) => (
                    <div key={`${latestJob.id}-recovery-${index}`} className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                      {typeof action === "string" ? action : JSON.stringify(action)}
                    </div>
                  ))}
                </div>
              ) : null}

              {Array.isArray(latestJob.executionLog) && latestJob.executionLog.length ? (
                <div className="space-y-2">
                  {latestJob.executionLog.slice(0, 6).map((step, index) => (
                    <div key={`${latestJob.id}-${index}`} className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                      <div className="font-medium text-foreground">{String(step.label || step.step || `Step ${index + 1}`)}</div>
                      <div className="mt-1">{String(step.detail || step.status || "")}</div>
                    </div>
                  ))}
                </div>
              ) : null}

              {Array.isArray(latestJob.result?.prefillComparison) && latestJob.result.prefillComparison.length ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-foreground">Iris pre-fill differences</div>
                  {latestJob.result.prefillComparison.map((item, index) => {
                    const entry = item as {
                      label?: string;
                      portalValue?: string;
                      packetValue?: string;
                    };
                    return (
                      <div key={`${latestJob.id}-prefill-${index}`} className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
                        <div className="font-medium text-foreground">{entry.label || `Field ${index + 1}`}</div>
                        <div className="mt-1">Portal: {entry.portalValue || "-"}</div>
                        <div>Packet: {entry.packetValue || "-"}</div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {screenshotCaptures.length ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {screenshotCaptures.map((capture, index) => {
                    const label =
                      typeof capture === "object" && capture && "label" in capture
                        ? String((capture as { label?: string }).label)
                        : `Capture ${index + 1}`;
                    const image =
                      typeof capture === "object" && capture && "dataUrl" in capture
                        ? String((capture as { dataUrl?: string }).dataUrl)
                        : "";

                    if (!image) {
                      return null;
                    }

                    return (
                      <div key={`${latestJob.id}-capture-${index}`} className="overflow-hidden rounded-lg border">
                        <div className="border-b px-3 py-2 text-sm font-medium">{label}</div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image} alt={label} className="w-full bg-white object-contain" />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground">
                  Screenshot captures will appear here after the desktop job returns them.
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Human gates that still remain</CardTitle>
          <CardDescription>
            Dry run proves the fill path only. It does not grant the agent authority to finish the filing.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><ShieldAlert className="h-4 w-4 text-[#8A641F]" /> Final submit stays manual</div>
            The agent stops before the final declaration and submit action.
          </div>
          <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><TriangleAlert className="h-4 w-4 text-[#8A641F]" /> OTP, captcha, PIN, and payment stay human-controlled</div>
            Dry run never clears those gates automatically.
          </div>
          <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><CheckCircle2 className="h-4 w-4 text-primary" /> Packet hash stays bound</div>
            The desktop job uses the approved packet version/hash captured in the queue payload.
          </div>
          <div className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground"><ShieldCheck className="h-4 w-4 text-primary" /> Trusted device only</div>
            Status updates are scoped to the same trusted device that claimed the job.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
