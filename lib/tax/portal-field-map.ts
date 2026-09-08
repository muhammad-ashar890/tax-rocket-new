/**
 * Portal Field Map Builder
 * Converts our ledgerEntries + taxCredits into IRIS field mappings
 * Used in filing packet snapshot for Electron agent
 */

import {
  IRIS_CODES,
  CATEGORY_TO_IRIS_MAP,
  TAX_SECTION_TO_IRIS_CODE,
} from "./iris-field-codes";
import type { IrisRouteFamily } from "./fbr-agent-config";

export type PortalFieldMapEntry = {
  ledgerEntryId?: string;
  taxCreditId?: string;
  incomeRecordId?: string;
  ourCategory: string;
  ourDescription: string;
  ourAmount: number;
  irisCode: string;
  irisDescription: string;
  portalArea: string;
  section: string;
  column:
    | "Total Amount"
    | "Amount Exempt from Tax / Subject to Fixed / Final Tax"
    | "Amount Subject to Normal Tax"
    | "Tax Collected / Deducted"
    | "Amount";
  isTaxField: boolean;
  filerStatus?: string;
  propertyValue?: number;
};

export type PortalFieldMap = {
  version: string;
  generatedAt: string;
  taxYear: number;
  filerType: string | null;
  taxpayerListStatus: string | null;
  totalFields: number;
  incomeFields: PortalFieldMapEntry[];
  adjustableTaxFields: PortalFieldMapEntry[];
  wealthFields: PortalFieldMapEntry[];
  computationHints: {
    totalIncome: number;
    taxableIncome: number;
    totalTaxWithheld: number;
    pensionExemptLimit?: number;
    pensionExemptAmount?: number;
    pensionTaxableAmount?: number;
  };
  selectorBundle: {
    version: string;
    portalType: "IRIS_2_0" | "CLASSIC" | "AUTO";
  };
};

export type PortalAutofillField = {
  key: string;
  value: string;
  label: string;
  irisCode: string;
  irisSection: string;
  portalArea: string;
  column: PortalFieldMapEntry["column"];
  isTaxField: boolean;
  selector: string;
  rowSelector: string;
  topTab: "Data";
  leftPanel: string | null;
  leftSection: string | null;
  sourceGroup: "incomeFields" | "adjustableTaxFields" | "wealthFields";
  ledgerEntryId?: string;
  taxCreditId?: string;
  incomeRecordId?: string;
  ourCategory: string;
  ourDescription: string;
};

export type PacketRouteMetadata = {
  routeFamily: IrisRouteFamily | null;
  routeLabel: string | null;
  filingIntent: "original";
  requiresIdentification: boolean;
  source: "packet_builder";
  notes?: string[];
};

const SUPPORTED_IRIS_ROUTE_LABEL =
  "114(1) (Return of Income filed voluntarily for complete year)";

function buildPortalFieldRowSelector(irisCode: string) {
  return `[id="${irisCode}"]`;
}

function buildPortalFieldInputSelector(irisCode: string) {
  const rowSelector = buildPortalFieldRowSelector(irisCode);
  return [
    `${rowSelector} input:not([type=\"hidden\"]):not([disabled]):not([readonly])`,
    `${rowSelector} textarea:not([disabled]):not([readonly])`,
    `${rowSelector} select:not([disabled]):not([readonly])`,
  ].join(", ");
}

function getPortalNavigationHints(entry: PortalFieldMapEntry) {
  const portalArea = entry.portalArea.trim().toLowerCase();
  const section = entry.section.trim().toLowerCase();

  if (portalArea === "employment" || section === "salary") {
    return {
      topTab: "Data" as const,
      leftPanel: "Employment",
      leftSection: "Salary",
    };
  }

  if (
    portalArea === "tax chargeable / payments" ||
    section === "adjustable tax" ||
    section === "withholding tax" ||
    section === "final tax" ||
    section === "minimum tax"
  ) {
    return {
      topTab: "Data" as const,
      leftPanel: "Tax Chargeable / Payments",
      leftSection:
        section === "computations" ? "Computations" : "Withholding Tax",
    };
  }

  if (portalArea === "116 - wealth statement") {
    return {
      topTab: "Data" as const,
      leftPanel: "116 - Wealth Statement",
      leftSection:
        section === "reconciliation of net assets"
          ? "Reconciliation of Net Assets"
          : "Personal Assets / Liabilities",
    };
  }

  return {
    topTab: "Data" as const,
    leftPanel: null,
    leftSection: null,
  };
}

function toPortalAutofillField(
  entry: PortalFieldMapEntry,
  sourceGroup: PortalAutofillField["sourceGroup"],
): PortalAutofillField {
  const rowSelector = buildPortalFieldRowSelector(entry.irisCode);
  const hints = getPortalNavigationHints(entry);
  return {
    key: `${entry.irisCode}:${sourceGroup}:${entry.column}`,
    value: String(entry.ourAmount),
    label: entry.irisDescription,
    irisCode: entry.irisCode,
    irisSection: entry.section,
    portalArea: entry.portalArea,
    column: entry.column,
    isTaxField: entry.isTaxField,
    selector: buildPortalFieldInputSelector(entry.irisCode),
    rowSelector,
    ...hints,
    sourceGroup,
    ledgerEntryId: entry.ledgerEntryId,
    taxCreditId: entry.taxCreditId,
    incomeRecordId: entry.incomeRecordId,
    ourCategory: entry.ourCategory,
    ourDescription: entry.ourDescription,
  };
}

export function flattenPortalFieldMap(
  portalFieldMap: PortalFieldMap | null | undefined,
): PortalAutofillField[] {
  if (!portalFieldMap || typeof portalFieldMap !== "object") {
    return [];
  }

  const incomeFields = Array.isArray(portalFieldMap.incomeFields)
    ? portalFieldMap.incomeFields
    : [];
  const adjustableTaxFields = Array.isArray(portalFieldMap.adjustableTaxFields)
    ? portalFieldMap.adjustableTaxFields
    : [];
  const wealthFields = Array.isArray(portalFieldMap.wealthFields)
    ? portalFieldMap.wealthFields
    : [];

  return [
    ...incomeFields.map((entry) =>
      toPortalAutofillField(entry, "incomeFields"),
    ),
    ...adjustableTaxFields.map((entry) =>
      toPortalAutofillField(entry, "adjustableTaxFields"),
    ),
    ...wealthFields.map((entry) =>
      toPortalAutofillField(entry, "wealthFields"),
    ),
  ];
}

export function buildPacketRouteMetadata(params: {
  taxYear: number;
  filerType: string | null;
  businessStructure: string | null;
  incomeSources?: readonly string[];
}): PacketRouteMetadata {
  const incomeSources = params.incomeSources ?? [];
  const businessStructure =
    params.businessStructure?.trim().toLowerCase() ?? null;
  const isSupportedIndividualRoute =
    params.taxYear === 2026 &&
    (params.filerType === "myself" ||
      (params.filerType === "my_business" &&
        (!businessStructure || businessStructure === "sole_proprietor")));

  if (!isSupportedIndividualRoute) {
    return {
      routeFamily: null,
      routeLabel: null,
      filingIntent: "original",
      requiresIdentification: true,
      source: "packet_builder",
      notes: [
        incomeSources.length > 0
          ? `No supported original individual IRIS route was inferred for filer profile (${params.filerType ?? "unknown"})`
          : "No supported original individual IRIS route was inferred from the packet profile",
      ],
    };
  }

  return {
    routeFamily: "normal_individual_114",
    routeLabel: SUPPORTED_IRIS_ROUTE_LABEL,
    filingIntent: "original",
    requiresIdentification: false,
    source: "packet_builder",
    notes:
      incomeSources.length > 0
        ? [`Income sources: ${incomeSources.join(", ")}`]
        : undefined,
  };
}

type LedgerEntryInput = {
  id?: string;
  entryType: string;
  category: string | null;
  description: string;
  amount: number | { toString(): string } | string;
};

type TaxCreditInput = {
  id?: string;
  section: string;
  subcategory: string;
  amount: number | { toString(): string } | string;
  source: string;
};

function toNumber(val: any): number {
  if (typeof val === "number") return val;
  if (val === null || val === undefined) return 0;
  if (typeof val === "string") return parseFloat(val) || 0;
  if (typeof val === "object" && "toString" in val)
    return parseFloat(val.toString()) || 0;
  return 0;
}

function normalizeCategory(cat: string | null | undefined): string {
  if (!cat) return "OTHER_INCOME";
  return cat
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9_]/g, "_");
}

export function buildPortalFieldMap(params: {
  taxYear: number;
  filerType: string | null;
  taxpayerListStatus: string | null;
  ledgerEntries: LedgerEntryInput[];
  taxCredits?: TaxCreditInput[];
  taxableIncome?: number;
  taxWithheld?: number;
  pensionDetails?: {
    totalPension: number;
    exemptLimit: number;
    exemptAmount: number;
    taxableAmount: number;
    age: number;
  };
}): PortalFieldMap {
  const {
    taxYear,
    filerType,
    taxpayerListStatus,
    ledgerEntries,
    taxCredits = [],
    taxableIncome = 0,
    taxWithheld = 0,
    pensionDetails,
  } = params;

  const incomeFields: PortalFieldMapEntry[] = [];
  const adjustableTaxFields: PortalFieldMapEntry[] = [];
  const wealthFields: PortalFieldMapEntry[] = [];

  let totalIncome = 0;

  for (const entry of ledgerEntries) {
    const amount = toNumber(entry.amount);
    if (amount <= 0) continue;

    const normalizedCat = normalizeCategory(entry.category);
    totalIncome += entry.entryType === "INCOME" ? amount : 0;

    const mappings = CATEGORY_TO_IRIS_MAP[normalizedCat] ||
      CATEGORY_TO_IRIS_MAP[entry.category?.toUpperCase() || ""] || [
        {
          incomeCode: IRIS_CODES.OTHER_SOURCES_OTHER_RECEIPTS.code,
          description: `Fallback for ${normalizedCat}`,
        },
      ];

    for (const mapping of mappings) {
      // Income field
      const irisDef = Object.values(IRIS_CODES).find(
        (c: any) => c.code === mapping.incomeCode,
      ) as any;
      incomeFields.push({
        ledgerEntryId: entry.id,
        ourCategory: normalizedCat,
        ourDescription: entry.description,
        ourAmount: amount,
        irisCode: mapping.incomeCode,
        irisDescription: irisDef?.description || mapping.description,
        portalArea: irisDef?.portalArea || "Other Sources",
        section: irisDef?.section || "Receipts / Deductions",
        column: "Amount Subject to Normal Tax",
        isTaxField: false,
        filerStatus: taxpayerListStatus || undefined,
      });

      // If mapping includes tax code, also add adjustable tax field (if we have tax credit for it)
      // For now, we add a placeholder for tax that will be filled from taxCredits
    }

    // Special handling for pension - split exempt vs taxable
    if (normalizedCat === "PENSION" && pensionDetails) {
      // Exempt portion goes to Amount Exempt column
      if (pensionDetails.exemptAmount > 0) {
        incomeFields.push({
          ledgerEntryId: entry.id,
          ourCategory: "PENSION_EXEMPT",
          ourDescription: `${entry.description} - Exempt portion (limit ${pensionDetails.exemptLimit})`,
          ourAmount: pensionDetails.exemptAmount,
          irisCode: IRIS_CODES.SALARY_PENSION_ANNUITY.code,
          irisDescription: "Pension exempt",
          portalArea: "Employment",
          section: "Salary",
          column: "Amount Exempt from Tax / Subject to Fixed / Final Tax",
          isTaxField: false,
        });
      }
      if (pensionDetails.taxableAmount > 0) {
        incomeFields.push({
          ledgerEntryId: entry.id,
          ourCategory: "PENSION_TAXABLE",
          ourDescription: `${entry.description} - Taxable above limit`,
          ourAmount: pensionDetails.taxableAmount,
          irisCode: IRIS_CODES.SALARY_PENSION_ANNUITY.code,
          irisDescription: "Pension taxable",
          portalArea: "Employment",
          section: "Salary",
          column: "Amount Subject to Normal Tax",
          isTaxField: false,
        });
      }
    }

    // Property handling - if RENT, also calculate 1/5th repair deduction
    if (["RENT", "RENTAL", "PROPERTY_RENT"].includes(normalizedCat)) {
      const repairDeduction = amount * 0.2; // 1/5th
      incomeFields.push({
        ledgerEntryId: entry.id,
        ourCategory: "PROPERTY_DEDUCTION_REPAIR",
        ourDescription: `1/5th Repair deduction for ${entry.description}`,
        ourAmount: repairDeduction,
        irisCode: IRIS_CODES.PROPERTY_REPAIR_1_5TH.code,
        irisDescription: IRIS_CODES.PROPERTY_REPAIR_1_5TH.description,
        portalArea: "Property",
        section: "Receipts / Deductions",
        column: "Total Amount",
        isTaxField: false,
      });
    }
  }

  // Process tax credits -> adjustable tax fields
  for (const credit of taxCredits) {
    const amount = toNumber(credit.amount);
    if (amount <= 0) continue;

    // Try to map section to IRIS code
    const sectionUpper = credit.section.toUpperCase();
    let irisCode =
      TAX_SECTION_TO_IRIS_CODE[credit.section] ||
      TAX_SECTION_TO_IRIS_CODE[sectionUpper];

    // Handle 236C and 236K specially - check subcategory
    if (!irisCode) {
      if (
        sectionUpper.includes("236C") ||
        credit.subcategory.toLowerCase().includes("236c") ||
        credit.subcategory.toLowerCase().includes("transfer")
      ) {
        irisCode = IRIS_CODES.ADJ_PROPERTY_TRANSFER_236C.code;
      } else if (
        sectionUpper.includes("236K") ||
        credit.subcategory.toLowerCase().includes("236k") ||
        credit.subcategory.toLowerCase().includes("purchase")
      ) {
        irisCode = IRIS_CODES.ADJ_PROPERTY_PURCHASE_236K.code;
      }
    }

    if (!irisCode) {
      // Fallback - use general adjustable tax code with description
      irisCode = IRIS_CODES.ADJUSTABLE_TAX.code;
    }

    const irisDef = Object.values(IRIS_CODES).find(
      (c: any) => c.code === irisCode,
    ) as any;

    adjustableTaxFields.push({
      taxCreditId: credit.id,
      ourCategory: `TAX_${sectionUpper}`,
      ourDescription: `${credit.section} - ${credit.subcategory} (${credit.source})`,
      ourAmount: amount,
      irisCode,
      irisDescription:
        irisDef?.description || `${credit.section} ${credit.subcategory}`,
      portalArea: irisDef?.portalArea || "Tax Chargeable / Payments",
      section: irisDef?.section || "Adjustable Tax",
      column: "Tax Collected / Deducted",
      isTaxField: true,
      filerStatus: taxpayerListStatus || undefined,
    });
  }

  // Wealth fields - from closing wealth etc (simplified)
  // For now, we add a placeholder that agent can use to fill wealth statement if needed
  // Actual wealth mapping needs user input - will be enhanced later

  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    taxYear,
    filerType,
    taxpayerListStatus,
    totalFields:
      incomeFields.length + adjustableTaxFields.length + wealthFields.length,
    incomeFields,
    adjustableTaxFields,
    wealthFields,
    computationHints: {
      totalIncome,
      taxableIncome,
      totalTaxWithheld: taxWithheld,
      pensionExemptLimit: pensionDetails?.exemptLimit,
      pensionExemptAmount: pensionDetails?.exemptAmount,
      pensionTaxableAmount: pensionDetails?.taxableAmount,
    },
    selectorBundle: {
      version: "v1.0-2026-05-11",
      portalType: "AUTO",
    },
  };
}

/**
 * Helper to build a minimal portalFieldMap for testing
 */
export function buildTestPortalFieldMap(): PortalFieldMap {
  return buildPortalFieldMap({
    taxYear: 2026,
    filerType: "SALARIED",
    taxpayerListStatus: "ATL",
    ledgerEntries: [
      {
        id: "test-1",
        entryType: "INCOME",
        category: "SALARY",
        description: "Salary",
        amount: 3000000,
      },
      {
        id: "test-2",
        entryType: "INCOME",
        category: "BANK_PROFIT",
        description: "Bank profit",
        amount: 1000000,
      },
      {
        id: "test-3",
        entryType: "INCOME",
        category: "RENT",
        description: "Rent",
        amount: 1500000,
      },
    ],
    taxCredits: [
      {
        id: "tax-1",
        section: "149",
        subcategory: "salary",
        amount: 200000,
        source: "SALARY",
      },
      {
        id: "tax-2",
        section: "236C",
        subcategory: "immovable-property-transfer",
        amount: 2250000,
        source: "ADVANCE_TAX",
      },
    ],
    taxableIncome: 5500000,
    taxWithheld: 2450000,
  });
}
