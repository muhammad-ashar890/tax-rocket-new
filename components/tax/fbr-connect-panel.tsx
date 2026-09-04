"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, ShieldCheck } from "lucide-react";

import {
  startFbrConnectionAction,
  type FbrConnectionView,
} from "@/app/actions/fbr";
import { Button } from "@/components/ui/button";

type FbrConnectPanelProps = Readonly<{
  draftId?: string;
  initialConnection: FbrConnectionView | null;
  onConnectionStatusChange?: (status: string) => void;
}>;

const STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: "Not started",
  WAITING_FOR_AGENT: "Waiting for local agent",
  CONNECTED: "Agent connected",
  RUNNING: "Filing in progress",
  COMPLETED: "Filing completed",
  FAILED: "Connection failed",
};

export default function FbrConnectPanel({
  draftId,
  initialConnection,
  onConnectionStatusChange,
}: FbrConnectPanelProps) {
  const [connection, setConnection] = useState(initialConnection);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    setConnection(initialConnection);
  }, [initialConnection]);

  useEffect(() => {
    onConnectionStatusChange?.(connection?.status ?? "NOT_STARTED");
  }, [connection?.status, onConnectionStatusChange]);

  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    if (!draftId) return;

    setStarting(true);
    setError(null);

    const result = await startFbrConnectionAction(draftId);
    setStarting(false);

    if (!result.success) {
      setError(result.error ?? "Failed to start FBR connection");
      return;
    }

    setConnection(result.connection);
  }

  const status = connection?.status ?? "NOT_STARTED";
  const isWaiting = status === "WAITING_FOR_AGENT";
  const isCompleted = status === "COMPLETED";

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center">
      <ShieldCheck className="h-6 w-6 text-amanah" />
      <p className="text-sm font-medium text-foreground">
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

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!draftId || starting || isWaiting || isCompleted}
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
            : isCompleted
              ? "Completed"
              : "Connect to Iris"}
      </Button>
    </div>
  );
}
