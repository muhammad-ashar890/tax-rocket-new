"use client";

import { AlertTriangle, CheckCircle2, Layers3 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StepHeading } from "@/components/tax/wizard-ui";
import {
  getTy2026SourceForStep,
  getTy2026SubcategoryOptions,
  getTy2026SubcategoryStep,
  type Ty2026IncomeSelectionInput,
  type Ty2026SubcategoryStepKey,
} from "@/lib/tax/rules/ty2026/subcategories";

type WizardIncomeSubcategoryStepProps = Readonly<{
  currentStepKey: Ty2026SubcategoryStepKey;
  selections: readonly Ty2026IncomeSelectionInput[];
  onToggle: (selection: Ty2026IncomeSelectionInput) => void;
}>;

export function WizardIncomeSubcategoryStep({
  currentStepKey,
  selections,
  onToggle,
}: WizardIncomeSubcategoryStepProps) {
  const source = getTy2026SourceForStep(currentStepKey);
  const step = getTy2026SubcategoryStep(source);
  const options = getTy2026SubcategoryOptions(source);
  const selectedSubcategories = new Set(
    selections
      .filter((selection) => selection.source === source)
      .map((selection) => selection.subcategory),
  );

  if (!step) return null;

  return (
    <div className="space-y-6">
      <StepHeading title={step.title} description={step.description} />

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="secondary">Tax Year 2026</Badge>
        <span>{options.length} categories available</span>
        <span>•</span>
        <span>{selectedSubcategories.size} selected</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const selected = selectedSubcategories.has(option.subcategory);
          const needsDetail =
            option.implementationStatus === "NEEDS_EXTERNAL_DETAIL";

          return (
            <button
              key={`${option.source}:${option.subcategory}`}
              type="button"
              aria-pressed={selected}
              onClick={() =>
                onToggle({
                  source: option.source,
                  subcategory: option.subcategory,
                })
              }
              className={`rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                selected
                  ? "border-amanah bg-amanah/5 shadow-sm"
                  : "border-border bg-card hover:border-amanah/40 hover:bg-muted/30"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    selected
                      ? "bg-amanah text-white"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {selected ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Layers3 className="h-4 w-4" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {option.label}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Section {option.sections.join(", ")}
                    {option.ruleCount > 1
                      ? ` • ${option.ruleCount} amount/rate bands`
                      : ""}
                  </p>
                  {needsDetail && (
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span>
                        Selection allowed; final calculation needs client
                        confirmation.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Select all that apply. Amount-specific slabs are chosen later from each
        saved income record; they are not separate income sources.
      </p>
    </div>
  );
}
