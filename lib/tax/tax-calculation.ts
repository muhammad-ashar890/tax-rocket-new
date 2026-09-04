// File: lib/tax/tax-calculation.ts

import {
  TY2026_PENSION_RULES,
  TY2026_RATE_CARD_RULES,
  getTy2026RateCardRule,
} from "./rules/ty2026";
import type { RateCardRule, RateCardValue } from "./rules/rate-card-types";
import type { TaxpayerListStatus } from "./tax-data-model";

const TY2026_TAX_YEAR = 2026;

export type RentalRecipientKind = "INDIVIDUAL_OR_AOP" | "COMPANY";

/** The income routes this calculator can price from the TY2026 catalog. */
export type TaxRouteKey =
  | "salary"
  | "pension"
  | "property_rent"
  | "bank_profit"
  | "services"
  | "other_income"
  | "capital_gains"
  | "business"
  | "dividend"
  | "foreign_income_assets";

/**
 * How a route's charge relates to the rest of the return.
 *
 * PROGRESSIVE routes are charged on a rising slab, so the rate that applies to
 * the last rupee depends on how much income sits beneath it. When two such
 * routes appear together the return must state whether they share one slab or
 * each read their own, and the FBR withholding rate card does not answer that
 * (it prices deduction at source, not assessment). That question is therefore
 * escalated rather than guessed.
 *
 * FLAT routes are charged at a single percentage of their own amount. Nothing
 * about them changes when other income exists, so they combine with anything
 * without raising the aggregation question at all.
 *
 * FINAL is a separate axis from the above: it records whether the deduction
 * discharges the liability, which decides refundability rather than rate.
 */
export type TaxRateShape = "PROGRESSIVE" | "FLAT";

/** One priced line of a return. */
export type TaxRouteBreakdown = {
  route: TaxRouteKey;
  rateShape: TaxRateShape;
  /** Income attributed to this route. */
  income: number;
  /** Tax from the rate-card band before any surcharge. */
  baseTax: number;
  /** Surcharge charged on calculated tax for this route. */
  surcharge: number;
  /** baseTax + surcharge for this route. */
  taxDue: number;
  /**
   * True where the deduction discharges the liability, so an over-deduction is
   * not converted into an automatic refund claim.
   */
  isFinalTax: boolean;
  /** Catalog rule IDs used to price this line. */
  appliedRuleIds: string[];
  note: string;
};

/** One income source handed to the calculator. */
export type TaxIncomeSource = {
  route: TaxRouteKey;
  income: number;
  /**
   * The catalog subcategory selected for this route.
   *
   * Routes whose section prices several different activities at different
   * percentages (services, other income) cannot be priced without it: Section
   * 153(1b) alone runs from 1.5% for advertising to 15% for unlisted services.
   * Guessing a row here would produce a confident, wrong number, so a route
   * that needs a subcategory and is given none reports NEEDS_RULES.
   *
   * Routes with a single catalogued row ignore this field.
   */
  subcategory?: string;
};

export type TaxCalculationResult = {
  status: "ESTIMATE" | "NEEDS_RULES";
  taxYear: number;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  taxableIncome: number | null;
  /** Tax from the rate-card band before any surcharge. */
  baseTax: number | null;
  /** Surcharge charged on calculated tax (never on gross income). */
  surcharge: number | null;
  /** baseTax + surcharge. */
  taxDue: number | null;
  taxPayable: number | null;
  refundDue: number | null;
  taxWithheld: number;
  /**
   * True only when every priced line is a final-tax route. On a mixed return
   * part of the liability is assessable, so this is false.
   */
  isFinalTax: boolean;
  /** Catalog rule IDs used, so a packet can cite the exact rate-card rows. */
  appliedRuleIds: string[];
  note: string;

  // ---- Per-source detail ---------------------------------------------------

  /** Every route priced in this estimate, in a stable order. */
  breakdown: TaxRouteBreakdown[];
  /** Tax arising from routes whose deduction is final. */
  finalTaxDue: number;
  /** Tax arising from routes that remain assessable. */
  assessableTaxDue: number;
};

type RouteComputation = {
  baseTax: number;
  surcharge: number;
  isFinalTax: boolean;
  appliedRuleIds: string[];
  note: string;
};

type RouteFailure = { error: string };

function isRouteFailure(
  value: RouteComputation | RouteFailure,
): value is RouteFailure {
  return "error" in value;
}

/**
 * Evaluates a single rate-card value against an amount.
 * Only the value kinds that this pilot calculator can safely compute are
 * handled; anything else returns null so the caller reports NEEDS_RULES
 * instead of inventing a number.
 */
function evaluateRateCardValue(
  value: RateCardValue,
  amount: number,
): number | null {
  switch (value.kind) {
    case "ZERO":
      return 0;
    case "PERCENT":
      return amount * (value.percent / 100);
    case "MARGINAL":
      return (
        value.baseTax + (amount - value.excessOver) * (value.percent / 100)
      );
    case "FIXED":
      return value.amount;
    default:
      // RANGE, COMPOSITE, REFERENCE, PER_UNIT and NOT_APPLICABLE all need
      // information the rate card does not supply on its own.
      return null;
  }
}

function matchesAmountCondition(
  candidate: RateCardRule,
  field: string,
  amount: number,
) {
  const condition = candidate.condition?.amount;
  if (!condition || condition.field !== field) return false;
  if (condition.minInclusive !== undefined && amount < condition.minInclusive) {
    return false;
  }
  if (
    condition.minExclusive !== undefined &&
    amount <= condition.minExclusive
  ) {
    return false;
  }
  if (condition.maxInclusive !== undefined && amount > condition.maxInclusive) {
    return false;
  }
  if (
    condition.maxExclusive !== undefined &&
    amount >= condition.maxExclusive
  ) {
    return false;
  }
  return true;
}

/**
 * Finds the single catalogued band that covers an amount. Returning null when
 * zero or multiple bands match keeps an ambiguous rate card from silently
 * picking the first row.
 */
function findBandRule(input: {
  section: string;
  subcategory: string;
  field: string;
  amount: number;
}): RateCardRule | null {
  const matches = TY2026_RATE_CARD_RULES.filter(
    (candidate) =>
      candidate.section === input.section &&
      candidate.subcategory === input.subcategory &&
      matchesAmountCondition(candidate, input.field, input.amount),
  );
  return matches.length === 1 ? matches[0] : null;
}

function selectStatusRate(
  candidate: RateCardRule,
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">,
): RateCardValue | null {
  // Late Filer: try LATE_FILER first, then ATL (filer), then DEFAULT
  // This matches FBR logic: late filer is still a filer, not non-filer
  if (filerStatus === "LATE_FILER") {
    return (
      candidate.rates.LATE_FILER ??
      candidate.rates.ATL ??
      candidate.rates.DEFAULT ??
      null
    );
  }
  return candidate.rates[filerStatus] ?? candidate.rates.DEFAULT ?? null;
}

/**
 * Surcharge is always charged on calculated tax, never on gross or taxable
 * income. The catalog enforces `basis: "CALCULATED_TAX"`, and this helper
 * refuses any other basis rather than applying it to the wrong figure.
 */
function calculateSurchargeOnTax(
  surchargeRule: RateCardRule | null,
  calculatedTax: number,
): number {
  const surcharge = surchargeRule?.surcharge;
  if (!surcharge) return 0;
  if (surcharge.basis !== "CALCULATED_TAX") return 0;
  return calculatedTax * (surcharge.percent / 100);
}

function computeSalaryRoute(
  taxableIncome: number,
): RouteComputation | RouteFailure {
  const band = findBandRule({
    section: "149",
    subcategory: "salary",
    field: "taxableIncome",
    amount: taxableIncome,
  });
  if (!band) {
    return { error: "No TY2026 salary band covers this taxable income." };
  }

  const rate = band.rates.DEFAULT;
  if (!rate) return { error: "The TY2026 salary band has no catalogued rate." };

  const baseTax = evaluateRateCardValue(rate, taxableIncome);
  if (baseTax === null) {
    return { error: "The TY2026 salary band rate cannot be calculated." };
  }

  // Section 149 read with the proviso to section 4AB: taxable income above
  // PKR 10 million attracts a 9% surcharge on the calculated tax.
  const surchargeRule = getTy2026RateCardRule(
    "TY2026-149-SALARY-SURCHARGE-ABOVE-10M",
  );
  const surchargeApplies =
    surchargeRule !== null &&
    matchesAmountCondition(surchargeRule, "taxableIncome", taxableIncome);
  const surcharge = surchargeApplies
    ? calculateSurchargeOnTax(surchargeRule, baseTax)
    : 0;

  const appliedRuleIds = [band.id];
  if (surchargeApplies && surchargeRule) appliedRuleIds.push(surchargeRule.id);

  return {
    baseTax,
    surcharge,
    isFinalTax: false,
    appliedRuleIds,
    note: surchargeApplies
      ? "Pilot estimate using TY2026 Section 149 salary slabs plus the 9% surcharge charged on calculated tax. Credits, perquisites and deductions still require review."
      : "Pilot estimate using TY2026 Section 149 salary slabs from the FBR WHT Rate Card. Credits, perquisites and deductions still require review.",
  };
}

function computePensionRoute(input: {
  annualPension: number;
  pensionerAgeBelow70?: boolean;
  pensionerAgeReason?: string;
}): RouteComputation | RouteFailure {
  const { annualPension } = input;

  if (annualPension <= TY2026_PENSION_RULES.exemptUpTo) {
    const exemptRule = getTy2026RateCardRule("TY2026-149IA-PENSION-UP-TO-10M");
    return {
      baseTax: 0,
      surcharge: 0,
      isFinalTax: false,
      appliedRuleIds: exemptRule ? [exemptRule.id] : [],
      note: "TY2026 pension income up to PKR 10,000,000 is exempt under Section 149(IA).",
    };
  }

  // Above PKR 10 million the rate card only states the treatment for a
  // pensioner below 70. It is silent for age 70 and above, so that case must
  // not fall through to the salary slabs.
  if (input.pensionerAgeBelow70 !== true) {
    return {
      error:
        input.pensionerAgeReason ??
        "Pension above PKR 10,000,000 is only catalogued for a pensioner below 70. Confirm the pensioner's age; the rate card does not state the age-70-or-above treatment.",
    };
  }

  const band = getTy2026RateCardRule(
    "TY2026-149IA-PENSION-ABOVE-10M-BELOW-AGE-70",
  );
  if (!band?.rates.DEFAULT) {
    return { error: "The TY2026 pension rule is not catalogued." };
  }

  const baseTax = evaluateRateCardValue(band.rates.DEFAULT, annualPension);
  if (baseTax === null) {
    return { error: "The TY2026 pension rate cannot be calculated." };
  }

  const surcharge = calculateSurchargeOnTax(band, baseTax);

  return {
    baseTax,
    surcharge,
    isFinalTax: false,
    appliedRuleIds: [band.id],
    note: "Pilot estimate using TY2026 Section 149(IA): 5% on pension above PKR 10,000,000 plus a 10% surcharge charged on calculated tax.",
  };
}

function computeRentalRoute(input: {
  grossRent: number;
  recipientKind: RentalRecipientKind;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
}): RouteComputation | RouteFailure {
  if (input.recipientKind === "COMPANY") {
    const companyRule = getTy2026RateCardRule("TY2026-155-RENT-COMPANY");
    const rate = companyRule
      ? selectStatusRate(companyRule, input.filerStatus)
      : null;
    if (!companyRule || !rate) {
      return { error: "The TY2026 company rental rule is not catalogued." };
    }

    const baseTax = evaluateRateCardValue(rate, input.grossRent);
    if (baseTax === null) {
      return { error: "The TY2026 company rental rate cannot be calculated." };
    }

    return {
      baseTax,
      surcharge: 0,
      isFinalTax: false,
      appliedRuleIds: [companyRule.id],
      note: `Pilot estimate using the TY2026 Section 155 ${input.filerStatus} company rental rate. Deductions and final-return rules still require review.`,
    };
  }

  const band = findBandRule({
    section: "155",
    subcategory: "individual-aop",
    field: "grossRent",
    amount: input.grossRent,
  });
  if (!band?.rates.DEFAULT) {
    return { error: "No TY2026 individual/AOP rental band covers this rent." };
  }

  const baseTax = evaluateRateCardValue(band.rates.DEFAULT, input.grossRent);
  if (baseTax === null) {
    return { error: "The TY2026 rental band rate cannot be calculated." };
  }

  return {
    baseTax,
    surcharge: 0,
    isFinalTax: false,
    appliedRuleIds: [band.id],
    note: "Pilot estimate using TY2026 Section 155 individual/AOP rental slabs. Deductions and final-return rules still require review.",
  };
}

/**
 * Prices any route whose charge is a single percentage of its own amount.
 *
 * The route's identity comes entirely from `FLAT_ROUTE_DEFINITIONS`, so this
 * function never needs to know which route it is pricing. That is what keeps
 * a new flat route to one catalog entry instead of a new branch here.
 *
 * Every step that could go wrong returns a failure rather than a fallback: an
 * unrecognised subcategory, a subcategory the calculator has not been cleared
 * to price, a missing ATL/Non-ATL rate, or a rate the evaluator cannot compute
 * (RANGE, COMPOSITE and friends). A wrong tax number is worse than no number.
 */
function computeFlatRoute(input: {
  route: TaxRouteKey;
  income: number;
  subcategory: string | undefined;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
}): RouteComputation | RouteFailure {
  const definition = FLAT_ROUTE_DEFINITIONS[input.route];
  if (!definition) {
    return { error: `Route ${input.route} is not catalogued as a flat route.` };
  }

  const label = ROUTE_LABELS[input.route];
  const available = TY2026_RATE_CARD_RULES.filter(
    (candidate) => candidate.source === definition.catalogSource,
  );

  // A single-row route needs no choice, so an omitted subcategory is fine
  // there. A multi-row route cannot be priced without knowing which row the
  // filing selected: Section 153(1b) alone spans 1.5% to 15%.
  let subcategory = input.subcategory;
  if (!subcategory) {
    if (definition.subcategories.length !== 1) {
      return {
        error:
          `TY2026 ${label} is charged at a different rate for each catalogued category, ` +
          `so the selected category is required before this route can be priced.`,
      };
    }
    subcategory = definition.subcategories[0];
  }

  if (!definition.subcategories.includes(subcategory)) {
    return {
      error:
        `The TY2026 ${label} category "${subcategory}" is not one this calculator prices. ` +
        `Confirmed rules are required before it can be included in an estimate.`,
    };
  }

  const matches = available.filter(
    (candidate) => candidate.subcategory === subcategory,
  );
  if (matches.length !== 1) {
    // Zero means the catalog and this definition have drifted apart. More than
    // one means the row is ambiguous, and picking the first would be a guess.
    return {
      error: `The TY2026 ${label} category "${subcategory}" does not resolve to exactly one rate-card row.`,
    };
  }

  const rule = matches[0];

  // Some rows only apply within an amount band — Sukuk held by an individual
  // or AOP is 12.5% above a PKR 1 million return and 10% below it. The band is
  // part of the rule's identity, so pricing income that falls outside it would
  // apply a rate the rate card does not give for that amount.
  const amountCondition = rule.condition?.amount;
  if (
    amountCondition &&
    !matchesAmountCondition(rule, amountCondition.field, input.income)
  ) {
    const sibling = available.find(
      (candidate) =>
        candidate.subcategory !== subcategory &&
        candidate.condition?.amount?.field === amountCondition.field &&
        matchesAmountCondition(
          candidate,
          amountCondition.field,
          input.income,
        ),
    );
    return {
      error:
        `The selected TY2026 ${label} category "${subcategory}" is only catalogued for a different amount band, ` +
        `so it cannot price PKR ${Math.round(input.income).toLocaleString()}.` +
        (sibling
          ? ` The rate card places this amount under "${sibling.subcategory}"; select that category and recalculate.`
          : ""),
    };
  }
  const rate = selectStatusRate(rule, input.filerStatus);
  if (!rate) {
    return {
      error: `No ${input.filerStatus} rate is catalogued for TY2026 ${label} (${subcategory}).`,
    };
  }

  const baseTax = evaluateRateCardValue(rate, input.income);
  if (baseTax === null) {
    return {
      error: `The TY2026 ${label} rate for "${subcategory}" cannot be calculated from the rate card alone.`,
    };
  }

  const finalTaxNote = definition.isFinalTax
    ? ", treated as a final-tax route"
    : "";

  return {
    baseTax,
    surcharge: 0,
    isFinalTax: definition.isFinalTax,
    appliedRuleIds: [rule.id],
    note:
      `Pilot ${input.filerStatus} estimate for TY2026 ${definition.noteSubject} ` +
      `(${rule.label ?? subcategory}, Section ${rule.section})${finalTaxNote}. ` +
      `Final-return treatment still requires review.`,
  };
}

/**
 * Routes that are a plain percentage of their own amount, described as data.
 *
 * Everything these routes need is already in the rate card: pick the row the
 * filing selected, read the ATL or Non-ATL percentage, multiply. There is no
 * per-route formula to write, so adding another flat route is one entry in
 * this catalog rather than a new branch in the pricing loop.
 *
 * `catalogSource` is the `source` field on the rate-card rules, and
 * `subcategories` lists exactly which rows this calculator will price. A row
 * absent from that list is not silently priced with a sibling's rate; the
 * estimate stops with NEEDS_RULES instead.
 *
 * `isFinalTax` is stated per route rather than inferred. The rate card prices
 * deduction at source and does not say whether a deduction discharges the
 * liability, so treating a route as final is a decision, not a derivation.
 */
type FlatRouteDefinition = {
  catalogSource: string;
  /** Catalog subcategories this calculator will price, in display order. */
  subcategories: readonly string[];
  /**
   * Whether deduction under this route discharges the liability. Only Section
   * 151 profit on debt is treated as final here; every other route below stays
   * assessable, which is the safer default because it keeps the amount inside
   * the refundable pool rather than writing off a client's refund claim.
   */
  isFinalTax: boolean;
  /** Sentence fragment naming the charge, used in the estimate note. */
  noteSubject: string;
};

const FLAT_ROUTE_DEFINITIONS: Partial<
  Record<TaxRouteKey, FlatRouteDefinition>
> = {
  // Section 151: a single percentage of the profit paid.
  bank_profit: {
    catalogSource: "bank_profit",
    subcategories: [
      "bank-or-financial-institution-deposit",
      "government-securities-non-individual",
      "other-profit-on-debt",
      "sukuk-company",
      // The two individual/AOP Sukuk rows are split by a PKR 1 million band on
      // the return itself, which computeFlatRoute enforces before pricing.
      "sukuk-individual-aop-above-1m",
      "sukuk-individual-aop-below-1m",
    ],
    // Deducted as a final tax, so excess withholding is not turned into an
    // automatic refund.
    isFinalTax: true,
    noteSubject: "Section 151 bank profit",
  },
  // Section 152 — payments to non-residents. Nineteen catalogued rows.
  //
  // Twelve of them (sub-sections 1 through 1DB) carry a SINGLE rate on the
  // rate card: the Non-ATL column is blank, so a filer and a non-filer are
  // charged identically. That is the card's own position, not a gap here, and
  // it is confirmed with the client. The remaining seven rows, all under
  // 152(2A), do split ATL from Non-ATL.
  //
  // The two individual/AOP Sukuk rows under 1DB are split by a PKR 1 million
  // band on the return itself, which computeFlatRoute enforces before pricing.
  foreign_income_assets: {
    catalogSource: "foreign_income_assets",
    subcategories: [
      "1",
      "1a",
      "1aa",
      "1aaa",
      "1ba",
      "1c",
      "1d-holding-over-12-months",
      "1d-holding-under-12-months",
      "1da",
      "1db-sukuk-company",
      "1db-sukuk-individual-aop-above-1m",
      "1db-sukuk-individual-aop-below-1m",
      "2a-a-company",
      "2a-a-other",
      "2a-b-it-ites",
      "2a-b-certain-other-services",
      "2a-b-other-services",
      "2a-c-sportsperson",
      "2a-c-other",
    ],
    // Section 152 withholding is not stated as a final discharge on the rate
    // card, so it stays adjustable like every other non-151 route.
    isFinalTax: false,
    noteSubject: "Section 152 payment to a non-resident",
  },
  // Section 153(1b)/153(2)/154A. Seven catalogued rows spanning 0.25% to 15%,
  // so the selected subcategory decides the rate.
  services: {
    catalogSource: "services",
    subcategories: [
      "1b-service-certain",
      "1b-service-it-ites",
      "1b-service-advertising-media",
      "1b-service-other",
      "2-services-to-exporter",
      "export-it-ites-pseb",
      "export-services-other",
    ],
    isFinalTax: false,
    noteSubject: "services income",
  },
  // Section 156 prize winnings and Section 233 brokerage/commission.
  other_income: {
    catalogSource: "other_income",
    subcategories: [
      "prize-bond-crossword",
      "raffle-lottery-quiz-sales-promotion",
      "brokerage-commission-advertising-agent",
      "brokerage-commission-life-insurance-agent-below-500k",
      "brokerage-commission-other",
    ],
    isFinalTax: false,
    noteSubject: "other income",
  },
  // Section 151A gain on certain debt securities.
  capital_gains: {
    catalogSource: "capital_gains",
    subcategories: ["certain-debt-securities"],
    isFinalTax: false,
    noteSubject: "Section 151A capital gain",
  },
  // Sections 153(1a) supplies, 153(1c) contracts, 153(2A) e-commerce,
  // 154 exports, 156A petroleum, 236G/236H distribution and retail.
  //
  // Sixteen catalogued rows spanning 0.1% to 15%, so the selected subcategory
  // decides the rate. Note that Non-ATL is NOT simply double on three of these
  // rows: 236G fertilizer is 0.25%/0.70%, 236G other is 0.10%/2.00% and 236H
  // retail is 0.50%/2.50% (rate card page 13). The rates come from the catalog
  // rather than being derived, so those rows are priced correctly.
  business: {
    catalogSource: "business",
    subcategories: [
      "1a-supply-rice-cotton-seed-edible-oil",
      "1a-supply-company-toll-manufacturing",
      "1a-supply-company-other",
      "1a-supply-non-company-toll-manufacturing",
      "1a-supply-non-company-other",
      "1c-contract-sportsperson",
      "1c-contract-company",
      "1c-contract-other",
      "2a-ecommerce-digital",
      "2a-ecommerce-cod",
      "exports-1",
      "exports-3-3a-3b-3c",
      "petroleum-product-sale",
      "sale-to-distributor-fertilizer",
      "sale-to-distributor-other",
      "sale-to-retailer",
    ],
    isFinalTax: false,
    noteSubject: "business income",
  },
  // Section 150 dividends and Section 236Z bonus shares.
  //
  // "mutual-fund-proportional" is deliberately absent. That row is a COMPOSITE
  // charge — 25% of the debt-derived portion plus 15% of the equity-derived
  // portion — and the ledger holds one dividend amount with no evidence of how
  // it splits. Listing it here would price the whole amount at a single rate.
  // It stays out until the split is available, and reports NEEDS_RULES.
  dividend: {
    catalogSource: "dividend",
    subcategories: [
      "ipp",
      "reit-and-other",
      "mutual-fund-debt-50-or-more",
      "reit-receives-from-spv",
      "other-recipient-from-spv",
      "exempt-loss-or-credit-company",
      "bonus-shares",
    ],
    isFinalTax: false,
    noteSubject: "dividend income",
  },
};

/**
 * The rows each flat route is cleared to price, exposed for the verification
 * suite so it can assert that the catalog and these definitions have not
 * drifted apart. A row added to the rate card later must be reviewed and
 * listed deliberately rather than being priced unnoticed.
 */
export const FLAT_ROUTE_SUBCATEGORIES_FOR_TESTS: Record<
  string,
  readonly string[]
> = Object.fromEntries(
  Object.entries(FLAT_ROUTE_DEFINITIONS).map(([route, definition]) => [
    route,
    definition.subcategories,
  ]),
);

/**
 * Static facts about each route, used to decide how routes may be combined.
 *
 * `rateShape` is the important field. A flat route charges a fixed percentage
 * of its own amount, so its tax is identical whether it is filed alone or
 * beside anything else. A progressive route's rate depends on the income
 * beneath it, which is why two progressive routes together need a confirmed
 * aggregation rule.
 *
 * Rental is deliberately absent: Section 155 is progressive for an
 * individual/AOP but flat for a company, so its shape is resolved per filing
 * by `resolveRouteShape` rather than fixed here.
 */
const ROUTE_RATE_SHAPES: Record<
  Exclude<TaxRouteKey, "property_rent">,
  TaxRateShape
> = {
  // Section 149 slabs, plus a surcharge once taxable income passes 10m.
  salary: "PROGRESSIVE",
  // Section 149(IA): exempt to 10m, then 5% on the excess. The rate depends on
  // where the income sits, so it behaves progressively.
  pension: "PROGRESSIVE",
  bank_profit: "FLAT",
  services: "FLAT",
  other_income: "FLAT",
  capital_gains: "FLAT",
  business: "FLAT",
  dividend: "FLAT",
  foreign_income_assets: "FLAT",
};

function resolveRouteShape(
  route: TaxRouteKey,
  rentalRecipientKind: RentalRecipientKind,
): TaxRateShape {
  if (route === "property_rent") {
    // A company is charged one percentage; an individual/AOP reads a slab.
    return rentalRecipientKind === "COMPANY" ? "FLAT" : "PROGRESSIVE";
  }
  return ROUTE_RATE_SHAPES[route];
}

const ROUTE_LABELS: Record<TaxRouteKey, string> = {
  salary: "salary",
  pension: "pension",
  property_rent: "rental income",
  bank_profit: "profit on debt",
  services: "services income",
  other_income: "other income",
  capital_gains: "capital gains",
  business: "business income",
  dividend: "dividend income",
  foreign_income_assets: "payment to a non-resident",
};

/** Keeps breakdown lines and rule citations in a stable, predictable order. */
const ROUTE_ORDER: readonly TaxRouteKey[] = [
  "salary",
  "pension",
  "property_rent",
  "bank_profit",
  "services",
  "other_income",
  "capital_gains",
  "business",
  "dividend",
  "foreign_income_assets",
];

export function calculateTaxEstimate(input: {
  taxYear: number;
  filerStatus: Extract<TaxpayerListStatus, "ATL" | "NON_ATL" | "LATE_FILER">;
  totalIncome: number;
  totalExpenses: number;
  bankProfitIncome?: number;
  taxWithheld?: number;
  isSalariedRoute: boolean;
  isPensionRoute?: boolean;
  isRentalRoute?: boolean;
  isBankProfitRoute: boolean;
  /**
   * Income per route. Supplying this prices every listed route and returns a
   * per-route breakdown. When omitted the single selected route is priced from
   * `totalIncome`, preserving the earlier single-route behaviour.
   */
  incomeSources?: readonly TaxIncomeSource[];
  /** Section 149(IA) only catalogues pension above PKR 10m for age below 70. */
  pensionerAgeBelow70?: boolean;
  /** Operator-facing explanation shown when the age condition blocks a route. */
  pensionerAgeReason?: string;
  /** Section 155 charges an individual/AOP by slab and a company at a flat rate. */
  rentalRecipientKind?: RentalRecipientKind;
}): TaxCalculationResult {
  const bankProfitIncome = Math.max(0, input.bankProfitIncome ?? 0);
  // Salary is not reduced by ordinary personal/bank-account expenses. Those
  // expenses belong in wealth reconciliation, not the salary tax base.
  const taxableIncome = input.isBankProfitRoute
    ? bankProfitIncome
    : Math.max(0, input.totalIncome);
  const taxWithheld = Math.max(0, input.taxWithheld ?? 0);

  const needsRules = (note: string): TaxCalculationResult => ({
    status: "NEEDS_RULES",
    taxYear: input.taxYear,
    filerStatus: input.filerStatus,
    taxableIncome: null,
    baseTax: null,
    surcharge: null,
    taxDue: null,
    taxPayable: null,
    refundDue: null,
    taxWithheld,
    isFinalTax: false,
    appliedRuleIds: [],
    note,
    breakdown: [],
    finalTaxDue: 0,
    assessableTaxDue: 0,
  });

  if (input.taxYear !== TY2026_TAX_YEAR) {
    return needsRules(
      `Only Tax Year ${TY2026_TAX_YEAR} rate-card rules are currently implemented.`,
    );
  }

  const rentalRecipientKind = input.rentalRecipientKind ?? "INDIVIDUAL_OR_AOP";

  // Build the list of routes to price. An explicit `incomeSources` list drives
  // a multi-source return; otherwise the selected route flags are converted
  // into a one-entry list so both paths run through the same code below.
  const selectedRouteFlags: Array<[TaxRouteKey, boolean]> = [
    ["salary", input.isSalariedRoute],
    ["pension", input.isPensionRoute ?? false],
    ["property_rent", input.isRentalRoute ?? false],
    ["bank_profit", input.isBankProfitRoute],
  ];
  const flaggedRoutes = selectedRouteFlags
    .filter(([, selected]) => selected)
    .map(([route]) => route);

  let requestedSources: TaxIncomeSource[];

  if (input.incomeSources && input.incomeSources.length > 0) {
    // Merge duplicates so a caller listing the same thing twice cannot
    // double-charge. The key is route AND subcategory, not route alone: a
    // filing may hold two services categories charged at different rates
    // (IT/ITES at 4% and advertising at 1.5%), and collapsing those into one
    // line would price part of the income at the wrong percentage.
    const totals = new Map<
      string,
      { route: TaxRouteKey; subcategory?: string; income: number }
    >();
    for (const source of input.incomeSources) {
      const key = `${source.route}::${source.subcategory ?? ""}`;
      const existing = totals.get(key);
      if (existing) {
        existing.income += Math.max(0, source.income);
      } else {
        totals.set(key, {
          route: source.route,
          subcategory: source.subcategory,
          income: Math.max(0, source.income),
        });
      }
    }
    // Order by route first so the breakdown stays stable, then keep the
    // caller's order within a route.
    requestedSources = ROUTE_ORDER.flatMap((route) =>
      Array.from(totals.values()).filter((entry) => entry.route === route),
    );
  } else {
    if (flaggedRoutes.length === 0) {
      return needsRules(
        "A route-specific FBR tax rule set is required before calculating a final estimate.",
      );
    }
    if (flaggedRoutes.length > 1) {
      return needsRules(
        "Combined-route filings need per-route income. Provide incomeSources so each selected route can be priced separately.",
      );
    }
    const [only] = flaggedRoutes;
    requestedSources = [
      {
        route: only,
        income: only === "bank_profit" ? bankProfitIncome : taxableIncome,
      },
    ];
  }

  if (requestedSources.length === 0) {
    return needsRules(
      "A route-specific FBR tax rule set is required before calculating a final estimate.",
    );
  }

  // A route carrying no income cannot be priced, and silently dropping it
  // would hide a data problem behind a plausible-looking number.
  const emptyRoutes = requestedSources.filter((source) => source.income <= 0);
  if (emptyRoutes.length > 0) {
    const labels = emptyRoutes.map((source) => ROUTE_LABELS[source.route]);
    return needsRules(
      emptyRoutes.some((source) => source.route === "bank_profit")
        ? "Add an income ledger entry categorized as BANK_PROFIT before calculating this route."
        : `No income was recorded for ${labels.join(" and ")}. Add the ledger entries for that income before calculating.`,
    );
  }

  // The aggregation question. Two progressive routes together cannot be priced
  // until it is confirmed whether they share a single slab or read their own,
  // because the answer changes both the marginal rate and whether the 10m
  // surcharge threshold is crossed. Flat routes are unaffected either way, so
  // any combination involving them proceeds normally.
  const progressiveRoutes = requestedSources.filter(
    (source) =>
      resolveRouteShape(source.route, rentalRecipientKind) === "PROGRESSIVE",
  );

  if (progressiveRoutes.length > 1) {
    const labels = progressiveRoutes.map(
      (source) => ROUTE_LABELS[source.route],
    );
    const combined = progressiveRoutes.reduce(
      (total, source) => total + source.income,
      0,
    );
    return needsRules(
      `This filing combines ${labels.join(" and ")}, which are all charged on a rising slab. ` +
        `Confirm whether one slab is read against their combined income of PKR ${Math.round(combined).toLocaleString()}, ` +
        `or whether each source reads its own slab, and whether the PKR 10,000,000 surcharge threshold is tested on the combined figure. ` +
        `The FBR withholding rate card prices deduction at source and does not state the assessment rule, so this must be confirmed before an estimate is produced.`,
    );
  }

  // Price every route. Each helper is the same one used for single-route
  // filings, so a combined return cannot drift away from a solo return.
  const breakdown: TaxRouteBreakdown[] = [];

  for (const source of requestedSources) {
    let computed: RouteComputation | RouteFailure;

    // Flat routes are entirely described by FLAT_ROUTE_DEFINITIONS, so they
    // are dispatched as data before the switch. Only routes that need their
    // own formula appear as a case below.
    const flatDefinition = FLAT_ROUTE_DEFINITIONS[source.route];

    if (flatDefinition) {
      computed = computeFlatRoute({
        route: source.route,
        income: source.income,
        subcategory: source.subcategory,
        filerStatus: input.filerStatus,
      });
    } else {
      switch (source.route) {
        case "pension":
          computed = computePensionRoute({
            annualPension: source.income,
            pensionerAgeBelow70: input.pensionerAgeBelow70,
            pensionerAgeReason: input.pensionerAgeReason,
          });
          break;
        case "property_rent":
          computed = computeRentalRoute({
            grossRent: source.income,
            recipientKind: rentalRecipientKind,
            filerStatus: input.filerStatus,
          });
          break;
        case "salary":
          computed = computeSalaryRoute(source.income);
          break;
        default: {
          // Exhaustiveness guard: a route that is neither in
          // FLAT_ROUTE_DEFINITIONS nor handled above must stop the estimate
          // rather than fall through to another route's formula.
          computed = {
            error: `Route ${String(source.route)} is not catalogued.`,
          };
        }
      }
    }

    if (isRouteFailure(computed)) {
      return needsRules(computed.error);
    }

    const lineBaseTax = Math.max(0, Math.round(computed.baseTax));
    const lineSurcharge = Math.max(0, Math.round(computed.surcharge));

    breakdown.push({
      route: source.route,
      rateShape: resolveRouteShape(source.route, rentalRecipientKind),
      income: Math.round(source.income),
      baseTax: lineBaseTax,
      surcharge: lineSurcharge,
      taxDue: lineBaseTax + lineSurcharge,
      isFinalTax: computed.isFinalTax,
      appliedRuleIds: computed.appliedRuleIds,
      note: computed.note,
    });
  }

  const sum = (pick: (line: TaxRouteBreakdown) => number) =>
    breakdown.reduce((total, line) => total + pick(line), 0);

  const totalIncomePriced = sum((line) => line.income);
  const baseTax = sum((line) => line.baseTax);
  const surcharge = sum((line) => line.surcharge);
  const taxDue = baseTax + surcharge;

  const finalTaxDue = breakdown
    .filter((line) => line.isFinalTax)
    .reduce((total, line) => total + line.taxDue, 0);
  const assessableTaxDue = taxDue - finalTaxDue;

  const everyLineIsFinal =
    breakdown.length > 0 && breakdown.every((line) => line.isFinalTax);

  const taxPayable = Math.max(0, taxDue - taxWithheld);

  // A refund can only arise on the assessable part of the return. Withholding
  // under a final-tax route discharges that route's liability, so an
  // over-deduction there is not converted into an automatic refund claim.
  const refundDue = everyLineIsFinal ? 0 : Math.max(0, taxWithheld - taxDue);

  const excessWithholding = Math.max(0, taxWithheld - taxDue);
  const finalTaxNote =
    everyLineIsFinal && excessWithholding > 0
      ? ` PKR ${excessWithholding.toLocaleString()} was withheld above the calculated final tax; a refund is not claimed automatically and needs professional review.`
      : "";

  const combinedNote =
    breakdown.length === 1
      ? breakdown[0].note
      : breakdown
          .map((line) => `${ROUTE_LABELS[line.route]}: ${line.note}`)
          .join(" ");

  const mixedRegimeNote =
    breakdown.length > 1 && finalTaxDue > 0 && assessableTaxDue > 0
      ? ` PKR ${finalTaxDue.toLocaleString()} of this total is final tax and is not part of the assessable liability.`
      : "";

  return {
    status: "ESTIMATE",
    taxYear: input.taxYear,
    filerStatus: input.filerStatus,
    taxableIncome: totalIncomePriced,
    baseTax,
    surcharge,
    taxDue,
    taxPayable,
    refundDue,
    taxWithheld,
    isFinalTax: everyLineIsFinal,
    appliedRuleIds: breakdown.flatMap((line) => line.appliedRuleIds),
    note: `${combinedNote}${mixedRegimeNote}${finalTaxNote}`,
    breakdown,
    finalTaxDue,
    assessableTaxDue,
  };
}
