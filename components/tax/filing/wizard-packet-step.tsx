"use client";

import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WorkflowKpiCard,
  WorkflowKpiStrip,
} from "@/components/tax/workflow-page-shell";
import { StepHeading } from "@/components/tax/wizard-ui";

type FilingPacketSummary = {
  id: string;
  version: number;
  packetHash: string;
  status: string;
  taxPayable: number;
  refundDue: number;
  pdfUrl?: string | null;
};

/** One priced income source from the latest calculation. */
type TaxBreakdownLine = {
  source: string;
  section: string;
  ruleId: string;
  income: number;
  baseTax: number;
  surcharge: number;
  taxDue: number;
  isFinalTax: boolean;
  rateShape: string;
};

const SOURCE_LABELS: Record<string, string> = {
  salary: "Salary",
  pension: "Pension",
  property_rent: "Rental income",
  bank_profit: "Profit on debt",
  services: "Services income",
  other_income: "Other income",
  capital_gains: "Capital gains",
  business: "Business income",
  dividend: "Dividend",
  foreign_income_assets: "Non-Resident",
};

function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source.replaceAll("_", " ");
}

type WizardPacketStepProps = Readonly<{
  draftId?: string;
  filingPacket: FilingPacketSummary | null;
  filingSummary: {
    reconciliationGap: number | null;
    taxableIncome: number | null;
    taxPayable: number | null;
    refundDue: number | null;
    taxCalculationStatus: string;
    taxBreakdown?: TaxBreakdownLine[];
    finalTaxDue?: number;
    assessableTaxDue?: number;
  } | null;
  generatingPacket: boolean;
  generatingPdf: boolean;
  packetError: string | null;
  onGeneratePacket: () => void;
  onGeneratePdf: () => void;
}>;

export function WizardPacketStep({
  draftId,
  filingPacket,
  filingSummary,
  generatingPacket,
  generatingPdf,
  packetError,
  onGeneratePacket,
  onGeneratePdf,
}: WizardPacketStepProps) {
  const taxCalculationReady =
    filingSummary?.taxCalculationStatus === "ESTIMATE";
  const money = (value: number | null | undefined) =>
    !taxCalculationReady || value === null || value === undefined
      ? "Pending"
      : `PKR ${value.toLocaleString()}`;

  // Always formats, unlike `money`: the breakdown is only rendered once a
  // calculation exists, so its figures are never pending.
  const amount = (value: number) => `PKR ${Math.round(value).toLocaleString()}`;

  const breakdown = taxCalculationReady
    ? (filingSummary?.taxBreakdown ?? [])
    : [];
  const finalTaxDue = filingSummary?.finalTaxDue ?? 0;
  const assessableTaxDue = filingSummary?.assessableTaxDue ?? 0;
  const hasFinalTax = finalTaxDue > 0;

  const totals = breakdown.reduce(
    (running, line) => ({
      income: running.income + line.income,
      baseTax: running.baseTax + line.baseTax,
      surcharge: running.surcharge + line.surcharge,
      taxDue: running.taxDue + line.taxDue,
    }),
    { income: 0, baseTax: 0, surcharge: 0, taxDue: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="min-w-0">
          <StepHeading
            title="Your filing packet"
            description="Generate an immutable snapshot of your current filing data before approval."
          />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            onClick={onGeneratePacket}
            disabled={generatingPacket || !draftId}
            className="gap-2 bg-[#376952] text-white hover:bg-[#2e5a44]"
          >
            {generatingPacket ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {generatingPacket
              ? "Generating..."
              : filingPacket
                ? "Generate New Version"
                : "Generate Packet Snapshot"}
          </Button>

          {filingPacket &&
            (filingPacket.pdfUrl ? (
              <Button type="button" variant="outline" asChild className="gap-2">
                <a href={filingPacket.pdfUrl} download>
                  <Download className="h-4 w-4" />
                  Download PDF
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={onGeneratePdf}
                disabled={generatingPdf}
                className="gap-2"
              >
                {generatingPdf && <Loader2 className="h-4 w-4 animate-spin" />}
                {generatingPdf ? "Generating PDF..." : "Generate PDF"}
              </Button>
            ))}
        </div>
      </div>

      {packetError && (
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
          {packetError}
        </div>
      )}

      <WorkflowKpiStrip maxColumns={2}>
        <WorkflowKpiCard
          label="Packet version"
          value={filingPacket ? `v${filingPacket.version}` : "Not generated"}
        />
        <WorkflowKpiCard
          label="Packet hash"
          value={
            filingPacket ? `${filingPacket.packetHash.slice(0, 12)}…` : "—"
          }
          sub="SHA-256 snapshot fingerprint"
        />
        <WorkflowKpiCard
          label="Tax payable"
          value={money(filingSummary?.taxPayable)}
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Refund due"
          value={money(filingSummary?.refundDue)}
          accent="amanah"
        />
        <WorkflowKpiCard
          label="Reconciliation gap"
          value={
            filingSummary?.reconciliationGap === null ||
            filingSummary?.reconciliationGap === undefined
              ? "Pending"
              : `PKR ${Math.abs(filingSummary.reconciliationGap).toLocaleString()}`
          }
          accent="mizan"
        />
      </WorkflowKpiStrip>

      {breakdown.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="border-b border-border bg-muted/40 px-4 py-3">
            <h3 className="text-sm font-semibold">Tax by income source</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each source is charged under its own section of the rate card.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Source</th>
                  <th className="px-4 py-2 text-right font-medium">Income</th>
                  <th className="px-4 py-2 text-right font-medium">Tax</th>
                  <th className="px-4 py-2 text-right font-medium">
                    Surcharge
                  </th>
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((line) => (
                  <tr
                    key={`${line.source}-${line.ruleId}`}
                    className="border-b border-border/60 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {sourceLabel(line.source)}
                        </span>
                        {line.isFinalTax && (
                          <span className="rounded-full bg-amanah/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amanah">
                            Final tax
                          </span>
                        )}
                      </div>
                      {line.section && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          Section {line.section}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {amount(line.income)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {amount(line.baseTax)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {line.surcharge > 0 ? amount(line.surcharge) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">
                      {amount(line.taxDue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/30 font-semibold">
                  <td className="px-4 py-3">Total</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.income)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.baseTax)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {totals.surcharge > 0 ? amount(totals.surcharge) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {amount(totals.taxDue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {hasFinalTax && (
            <div className="border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <span>
                  Assessable tax:{" "}
                  <strong className="text-foreground tabular-nums">
                    {amount(assessableTaxDue)}
                  </strong>
                </span>
                <span>
                  Final tax:{" "}
                  <strong className="text-foreground tabular-nums">
                    {amount(finalTaxDue)}
                  </strong>
                </span>
              </div>
              <p className="mt-1.5">
                Tax deducted under a final-tax section discharges the liability
                on that income. Any excess deducted there is not claimed back
                automatically through this return.
              </p>
            </div>
          )}
        </div>
      )}

      {filingPacket && (
        <div className="rounded-xl border border-amanah/20 bg-amanah/5 p-4 text-sm text-amanah">
          Packet snapshot v{filingPacket.version} generated successfully.
          Approval can now be reviewed against this exact version.
        </div>
      )}
    </div>
  );
}
