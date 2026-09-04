import { TY2026_RATE_CARD_RULES } from "./catalog";
import type { RateCardRule } from "../rate-card-types";

export type Ty2026CatalogSource =
  | "imports"
  | "salary"
  | "pension"
  | "dividend"
  | "bank_profit"
  | "capital_gains"
  | "foreign_income_assets"
  | "business"
  | "services"
  | "property_rent"
  | "other_income"
  | "advance_tax";

export type Ty2026SubcategoryStepKey =
  | "subcategory_imports"
  | "subcategory_pension"
  | "subcategory_property_rent"
  | "subcategory_services"
  | "subcategory_bank_profit"
  | "subcategory_dividend"
  | "subcategory_business"
  | "subcategory_foreign_income_assets"
  | "subcategory_other_income"
  | "subcategory_advance_tax";

export type Ty2026IncomeSelectionInput = Readonly<{
  source: string;
  subcategory: string;
}>;

export type Ty2026SubcategoryOption = Readonly<{
  source: Ty2026CatalogSource;
  subcategory: string;
  label: string;
  sections: readonly string[];
  ruleIds: readonly string[];
  ruleCount: number;
  implementationStatus: "CATALOGUED" | "NEEDS_EXTERNAL_DETAIL";
}>;

export type Ty2026SubcategoryStepDefinition = Readonly<{
  key: Ty2026SubcategoryStepKey;
  source: Ty2026CatalogSource;
  title: string;
  railLabel: string;
  description: string;
}>;

export const TY2026_SUBCATEGORY_STEPS: readonly Ty2026SubcategoryStepDefinition[] =
  [
    {
      key: "subcategory_imports",
      source: "imports",
      title: "Which import categories apply?",
      railLabel: "Import categories",
      description:
        "Select every TY2026 import category that applies. You can choose more than one.",
    },
    {
      key: "subcategory_pension",
      source: "pension",
      title: "Which pension situations apply?",
      railLabel: "Pension categories",
      description:
        "Select every pension condition that applies to this filing.",
    },
    {
      key: "subcategory_property_rent",
      source: "property_rent",
      title: "Who received the rental income?",
      railLabel: "Rental categories",
      description: "Select the recipient type used by the TY2026 rental rules.",
    },
    {
      key: "subcategory_services",
      source: "services",
      title: "What type of services income was received?",
      railLabel: "Services categories",
      description:
        "Select all local, IT, advertising, exporter or export-service categories that apply.",
    },
    {
      key: "subcategory_bank_profit",
      source: "bank_profit",
      title: "What type of profit on debt was received?",
      railLabel: "Bank-profit categories",
      description:
        "Select every bank deposit, security, other profit-on-debt or Sukuk category that applies.",
    },
    {
      key: "subcategory_dividend",
      source: "dividend",
      title: "What type of dividend was received?",
      railLabel: "Dividend categories",
      description:
        "Select each dividend payer or fund category shown on the supporting documents.",
    },
    {
      key: "subcategory_business",
      source: "business",
      title: "Which business transaction categories apply?",
      railLabel: "Business categories",
      description:
        "Select all supply, contract, e-commerce, export and distribution categories that apply.",
    },
    {
      key: "subcategory_foreign_income_assets",
      source: "foreign_income_assets",
      title: "Which non-resident payment categories apply?",
      railLabel: "Non-resident categories",
      description:
        "Select every Section 152 payment or service category relevant to the filing.",
    },
    {
      key: "subcategory_other_income",
      source: "other_income",
      title: "What type of other income was received?",
      railLabel: "Other-income categories",
      description:
        "Select all prize, brokerage or commission categories that apply.",
    },
    {
      key: "subcategory_advance_tax",
      source: "advance_tax",
      title: "Which advance-tax transactions apply?",
      railLabel: "Advance-tax categories",
      description:
        "Select all vehicle, utility, property, auction, remittance or other advance-tax categories that apply.",
    },
  ] as const;

const SOURCE_BY_STEP = new Map<Ty2026SubcategoryStepKey, Ty2026CatalogSource>(
  TY2026_SUBCATEGORY_STEPS.map((step) => [step.key, step.source]),
);

const STEP_BY_SOURCE = new Map<
  Ty2026CatalogSource,
  Ty2026SubcategoryStepDefinition
>(TY2026_SUBCATEGORY_STEPS.map((step) => [step.source, step]));

const LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  "property_rent:individual-aop": "Rent received by an individual or AOP",
  "property_rent:company": "Rent received by a company",
  "advance_tax:motor-vehicle-value":
    "Motor vehicle purchase/registration — Section 231B(1)/(3)",
  "advance_tax:motor-vehicle-section-231b-2":
    "Motor vehicle transfer — Section 231B(2)",
  "advance_tax:motor-vehicle-section-231b-2a":
    "Motor vehicle lease — Section 231B(2A)",
  "advance_tax:passenger-transport-per-seat":
    "Passenger transport vehicle — per-seat tax",
  "advance_tax:motor-vehicle-annual": "Annual motor-vehicle tax",
  "advance_tax:motor-vehicle-lump-sum": "Lump-sum motor-vehicle tax",
  "advance_tax:electricity-commercial-industrial":
    "Commercial/industrial electricity bill up to PKR 20,000",
  "advance_tax:electricity-domestic-non-atl":
    "Domestic electricity bill — Non-ATL",
  "advance_tax:immovable-property-transfer":
    "Transfer/sale of immovable property",
  "advance_tax:immovable-property-purchase": "Purchase of immovable property",
};

const AUTOMATIC_SUBCATEGORIES: Readonly<
  Partial<Record<Ty2026CatalogSource, readonly string[]>>
> = {
  salary: ["salary", "salary-surcharge"],
  capital_gains: ["certain-debt-securities"],
};

function optionLabel(
  source: string,
  subcategory: string,
  rules: readonly RateCardRule[],
) {
  const override = LABEL_OVERRIDES[`${source}:${subcategory}`];
  if (override) return override;

  const first = rules[0]?.label ?? subcategory.replaceAll("-", " ");
  if (source === "foreign_income_assets") {
    return `Non-resident payment — ${first}`;
  }

  // Several amount-band rules share one subcategory. The amount/engine band
  // is derived from the later record, so a card represents the common route,
  // not one specific slab.
  return first.replace(/\s+[—-]\s+(up-to|above|\d).*/i, "");
}

const OPTIONS_BY_SOURCE = (() => {
  const grouped = new Map<string, RateCardRule[]>();
  for (const rule of TY2026_RATE_CARD_RULES) {
    const key = `${rule.source}\u0000${rule.subcategory}`;
    const existing = grouped.get(key) ?? [];
    existing.push(rule);
    grouped.set(key, existing);
  }

  const bySource = new Map<Ty2026CatalogSource, Ty2026SubcategoryOption[]>();
  for (const rules of grouped.values()) {
    const first = rules[0];
    const source = first.source as Ty2026CatalogSource;
    const option: Ty2026SubcategoryOption = {
      source,
      subcategory: first.subcategory,
      label: optionLabel(source, first.subcategory, rules),
      sections: Array.from(new Set(rules.map((rule) => rule.section))),
      ruleIds: rules.map((rule) => rule.id),
      ruleCount: rules.length,
      implementationStatus: rules.some(
        (rule) => rule.implementationStatus === "NEEDS_EXTERNAL_DETAIL",
      )
        ? "NEEDS_EXTERNAL_DETAIL"
        : "CATALOGUED",
    };
    const sourceOptions = bySource.get(source) ?? [];
    sourceOptions.push(option);
    bySource.set(source, sourceOptions);
  }

  return bySource;
})();

export function isTy2026SubcategoryStepKey(
  value: string,
): value is Ty2026SubcategoryStepKey {
  return SOURCE_BY_STEP.has(value as Ty2026SubcategoryStepKey);
}

export function getTy2026SourceForStep(
  key: Ty2026SubcategoryStepKey,
): Ty2026CatalogSource {
  return SOURCE_BY_STEP.get(key)!;
}

export function getTy2026SubcategoryStep(
  source: string,
): Ty2026SubcategoryStepDefinition | null {
  return STEP_BY_SOURCE.get(source as Ty2026CatalogSource) ?? null;
}

export function getTy2026SubcategoryOptions(
  source: string,
): readonly Ty2026SubcategoryOption[] {
  return OPTIONS_BY_SOURCE.get(source as Ty2026CatalogSource) ?? [];
}

export function getTy2026SubcategoryStepKeys(
  incomeSources: readonly string[],
  taxYear: number,
): Ty2026SubcategoryStepKey[] {
  if (taxYear !== 2026) return [];
  const selected = new Set(incomeSources);
  return TY2026_SUBCATEGORY_STEPS.filter((step) =>
    selected.has(step.source),
  ).map((step) => step.key);
}

export function isTy2026AutomaticIncomeSelection(
  selection: Ty2026IncomeSelectionInput,
) {
  return (
    AUTOMATIC_SUBCATEGORIES[selection.source as Ty2026CatalogSource]?.includes(
      selection.subcategory,
    ) ?? false
  );
}

export function getTy2026AutomaticIncomeSelections(
  incomeSources: readonly string[],
): Ty2026IncomeSelectionInput[] {
  const selections: Ty2026IncomeSelectionInput[] = [];
  for (const source of incomeSources) {
    for (const subcategory of AUTOMATIC_SUBCATEGORIES[
      source as Ty2026CatalogSource
    ] ?? []) {
      selections.push({ source, subcategory });
    }
  }
  return selections;
}

export function resolveTy2026IncomeSelections(input: {
  incomeSources: readonly string[];
  selections: readonly Ty2026IncomeSelectionInput[];
  requireComplete?: boolean;
}) {
  const selectedSources = new Set(input.incomeSources);
  const normalized = new Map<string, Ty2026IncomeSelectionInput>();

  for (const selection of [
    ...input.selections,
    ...getTy2026AutomaticIncomeSelections(input.incomeSources),
  ]) {
    if (!selectedSources.has(selection.source)) {
      return {
        success: false as const,
        error: `Subcategory source ${selection.source} is not selected`,
      };
    }

    const validOption = getTy2026SubcategoryOptions(selection.source).some(
      (option) => option.subcategory === selection.subcategory,
    );
    if (!validOption) {
      return {
        success: false as const,
        error: `Invalid TY2026 subcategory: ${selection.source}/${selection.subcategory}`,
      };
    }

    normalized.set(`${selection.source}\u0000${selection.subcategory}`, {
      source: selection.source,
      subcategory: selection.subcategory,
    });
  }

  if (input.requireComplete !== false) {
    for (const step of TY2026_SUBCATEGORY_STEPS) {
      if (!selectedSources.has(step.source)) continue;
      const hasSelection = Array.from(normalized.values()).some(
        (selection) => selection.source === step.source,
      );
      if (!hasSelection) {
        return {
          success: false as const,
          error: `Select at least one option under ${step.railLabel}`,
        };
      }
    }
  }

  return {
    success: true as const,
    selections: Array.from(normalized.values()),
  };
}

export function getTy2026SelectionDetails(source: string, subcategory: string) {
  const option = getTy2026SubcategoryOptions(source).find(
    (candidate) => candidate.subcategory === subcategory,
  );
  if (!option) return null;
  return {
    taxYear: 2026,
    ruleIds: option.ruleIds,
    sections: option.sections,
    implementationStatus: option.implementationStatus,
  };
}
