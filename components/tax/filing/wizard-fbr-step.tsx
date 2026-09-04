"use client";

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";

import {
  getFbrConnectionAction,
  type FbrConnectionView,
} from "@/app/actions/fbr";
import FbrConnectPanel from "@/components/tax/fbr-connect-panel";
import { StepHeading } from "@/components/tax/wizard-ui";

type WizardFbrStepProps = Readonly<{
  draftId?: string;
  onConnectionStatusChange?: (status: string) => void;
}>;

export function WizardFbrStep({
  draftId,
  onConnectionStatusChange,
}: WizardFbrStepProps) {
  const [connection, setConnection] = useState<FbrConnectionView | null>(null);

  useEffect(() => {
    if (!draftId) {
      setConnection(null);
      return;
    }

    let mounted = true;
    getFbrConnectionAction(draftId).then((result) => {
      if (mounted && result.success) {
        setConnection(result.connection);
      }
    });

    return () => {
      mounted = false;
    };
  }, [draftId]);

  return (
    <div className="space-y-6">
      <StepHeading
        title="File with FBR"
        description="Launch the supervised FBR Connect agent after the approved packet is ready."
      />

      <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-5">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-amanah/10 text-amanah">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <p className="font-semibold text-foreground">
          FBR Connect — supervised filing
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Your local Trusted Desktop Agent connects to Iris on your own machine.
          You will personally enter any OTP, CAPTCHA, or PIN.
        </p>
      </div>

      <FbrConnectPanel
        draftId={draftId}
        initialConnection={connection}
        onConnectionStatusChange={onConnectionStatusChange}
      />
    </div>
  );
}
