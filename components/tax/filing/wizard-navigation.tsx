"use client";

import { ArrowLeft, ArrowRight, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";

type WizardNavigationProps = Readonly<{
  step: number;
  isSetupReviewStep: boolean;
  isLastStep: boolean;
  submitting: boolean;
  canSubmit: boolean;
  canGoNext: boolean;
  onBack: () => void;
  onContinue: () => void;
  onCreateFiling: () => void;
}>;

export function WizardNavigation({
  step,
  isSetupReviewStep,
  isLastStep,
  submitting,
  canSubmit,
  canGoNext,
  onBack,
  onContinue,
  onCreateFiling,
}: WizardNavigationProps) {
  return (
    <div className="mt-8 flex items-center justify-between border-t pt-6">
      <Button
        type="button"
        variant="ghost"
        onClick={onBack}
        disabled={step === 0}
        className="gap-2"
      >
        <ArrowLeft className="h-4 w-4" />
        Back
      </Button>

      <div className="flex items-center gap-3">
        {isSetupReviewStep ? (
          <Button
            type="button"
            onClick={onCreateFiling}
            disabled={submitting || !canSubmit}
            className="gap-2"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Create Filing
          </Button>
        ) : !isLastStep ? (
          <Button
            type="button"
            onClick={onContinue}
            className="gap-2"
            disabled={!canGoNext}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
