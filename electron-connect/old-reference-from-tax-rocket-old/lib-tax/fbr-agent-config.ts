import "server-only";

import { createHash } from "node:crypto";

import { db } from "@/lib/db";
import type { IrisRouteFamily } from "@/lib/tax/iris-form-registry";
import { INCOME_CATEGORIES, type IncomeCategoryDefinition, type TaxTreatment } from "@/lib/tax/category-registry";

// ─── IRIS Portal Type (IRIS-6 fix) ───────────────────────────────────

/**
 * IRIS portal technology type.
 *
 * Determines the automation strategy the bot uses:
 * - "iris2": Angular 15 SPA (new portal at iris.fbr.gov.pk) — standard DOM clicks + form fills
 * - "irisv1": PrimeFaces JSF (classic portal at irisv1.fbr.gov.pk) — PrimeFaces.ab() AJAX calls + DataTable row-indexed inputs
 * - "both": Category appears in both portals
 */
export type IrisPortalType = "iris2" | "irisv1" | "both";

/**
 * Map an IRIS route family to its portal technology type.
 *
 * IRIS-6 fix: This function is the single source of truth for determining
 * whether the automation bot should use Angular DOM selectors (iris2) or
 * PrimeFaces JSF selectors (irisv1) for a given route.
 */
export function getPortalTypeForRouteFamily(
  routeFamily: IrisRouteFamily,
): IrisPortalType {
  switch (routeFamily) {
    case "classic_individual_114":
      return "irisv1";
    case "simplified_salary_114i":
    case "normal_individual_114":
    case "normal_individual_114_revised":
      return "iris2";
    case "wealth_statement":
    case "pre_step_application":
      return "both";
    default:
      return "iris2";
  }
}

/**
 * Get the portal type for a specific income category from the registry.
 * Used by the automation bot to determine field-filling strategy per category.
 */
export function getPortalTypeForCategory(
  category: IncomeCategoryDefinition,
): IrisPortalType {
  return category.irisPortalType ?? "iris2";
}

/**
 * Check whether a route family requires PrimeFaces JSF automation.
 * Convenience helper for bot automation strategy selection.
 */
export function isClassicPortalRoute(routeFamily: IrisRouteFamily): boolean {
  return getPortalTypeForRouteFamily(routeFamily) === "irisv1";
}

export type FbrDesktopAuthConfig = {
  loginUrl: string;
  readySelector: string;
  readyRejectSelector: string | null;
  readyUrlPattern: string | null;
  useMockIris: boolean;
};

export type FbrRouteSelectorConfig = {
  topMenuSelector: string;
  leftCategorySelector: string;
  formSelector: string;
  formReadySelector: string;
  periodSelector: string | null;
  nameSelector: string | null;
  generatePsidSelector: string | null;
  psidDisplaySelector: string | null;
  psidDownloadSelector: string | null;
  cprDisplaySelector: string | null;
  paidAmountSelector: string | null;
  balancePayableSelector: string | null;
  refundBannerSelector: string | null;
  submitButtonSelector: string | null;
  completionConfirmSelector: string | null;
};

export type FbrSelectorBundleSummary = {
  bundleId: string;
  bundleVersion: number;
  source: "default_code" | "user_settings" | "global_db";
  updatedAt: string;
  notes: string | null;
  hash: string;
};

export type FbrPortalAutomationConfig = {
  portalHostAllowlist: string[];
  readiness: {
    loginUrl: string;
    readySelector: string;
    readyRejectSelector: string | null;
    readyUrlPattern: string | null;
  };
  dryRun: {
    entryUrl: string;
    reviewGateSelector: string;
    finalSubmitSelector: string;
    completedTasksSelector: string | null;
    pauseReason: string;
  };
  assistedFiling: {
    readinessUrl: string;
    passwordResetUrl: string;
    otpCaptchaUrl: string;
    paymentUrl: string;
    finalReviewUrl: string;
    completedTasksUrl: string;
  };
  /** Phase 15.5c F9: Classic portal (PrimeFaces/JSF) assisted filing URLs.
   *  Classic portal has no mid-filing password reset, no OTP, no PSID for
   *  Section 154A final-tax cases. Instead it has save→submit→confirm dialog
   *  → rule engine validation → PIN entry → proof capture. */
  classicAssistedFiling: {
    /** After field fill, navigate to the classic portal final review page.
     *  Default: mock-iris://classic-portal (the full tree+data-table page). */
    finalReviewUrl: string;
    /** After submit confirmation, the classic portal shows a 4-digit PIN
     *  entry dialog. Default: mock-iris://classic-pin */
    pinEntryUrl: string;
    /** After PIN entry and final submission, the return moves from Drafts
     *  to Completed. Default: mock-iris://classic-fixed-final-tax */
    completedTasksUrl: string;
  };
  routeSelector: FbrRouteSelectorConfig | null;
  selectorBundle: FbrSelectorBundleSummary;
  useMockIris: boolean;
};

type FbrSelectorBundleSettings = {
  activeBundleId?: string;
  bundles?: unknown[];
};

type FbrSelectorBundleDefinition = {
  id: string;
  version: number;
  updatedAt: string;
  notes: string | null;
  routeSelectors: Record<IrisRouteFamily, FbrRouteSelectorConfig>;
};

type CachedSelectorBundle = {
  expiresAt: number;
  resolved: {
    activeBundle: FbrSelectorBundleSummary;
    selectorsByRouteFamily: Record<IrisRouteFamily, FbrRouteSelectorConfig>;
  };
};

const SELECTOR_CACHE_TTL_MS = Number(process.env.FBR_SELECTOR_BUNDLE_CACHE_TTL_MS) || 30_000;
const selectorBundleCache = new Map<string, CachedSelectorBundle>();

const REQUIRED_SELECTOR_KEYS = [
  "topMenuSelector",
  "leftCategorySelector",
  "formSelector",
  "formReadySelector",
] as const;

const OPTIONAL_SELECTOR_KEYS = [
  "periodSelector",
  "nameSelector",
  "generatePsidSelector",
  "psidDisplaySelector",
  "psidDownloadSelector",
  "cprDisplaySelector",
  "paidAmountSelector",
  "balancePayableSelector",
  "refundBannerSelector",
  "submitButtonSelector",
  "completionConfirmSelector",
] as const;

const ALL_ROUTE_FAMILIES: IrisRouteFamily[] = [
  "simplified_salary_114i",
  "normal_individual_114",
  "normal_individual_114_revised",
  "classic_individual_114",
  "wealth_statement",
  "pre_step_application",
];

const COMMON_RETURN_SELECTORS: Omit<FbrRouteSelectorConfig, "formSelector"> = {
  topMenuSelector:
    "#top-menu-income-tax-return, [data-iris-top-menu='income_tax_return'], a[href*='IncomeTaxReturn'], a[href*='income-tax-return']",
  leftCategorySelector:
    "#left-category-income-tax-return, [data-iris-left-category='income_tax_return'], a[href*='IncomeTaxReturn']",
  formReadySelector:
    "#iris-return-form-ready, form[data-iris-form-ready='true'], #return-tax-form",
  periodSelector:
    "#return-period, select[name='taxYear'], select[data-iris-field='tax_year'], input[name='taxYear']",
  nameSelector:
    "#taxpayer-name, input[name='taxpayerName'], input[data-iris-field='taxpayer_name']",
  generatePsidSelector: "#generate-psid, [data-action='generate-psid']",
  psidDisplaySelector: "#psid-number, [data-payment='psid-number']",
  psidDownloadSelector: "#download-psid, [data-action='download-psid']",
  cprDisplaySelector: "#cpr-reference, #mock-cpr-reference, [data-payment='cpr-reference']",
  paidAmountSelector: "#paid-amount, [data-payment='paid-amount']",
  balancePayableSelector: "#balance-payable, [data-payment='balance-payable']",
  refundBannerSelector: "#refund-banner, [data-payment='refund-banner']",
  submitButtonSelector: "#final-submit, button[data-action='submit-return'], button[type='submit']",
  completionConfirmSelector:
    "#completed-tasks-proof, [data-proof='completed-tasks'], [id*='completed-tasks']",
};

const DEFAULT_SELECTOR_BUNDLE: FbrSelectorBundleDefinition = {
  id: "v8-default-2026-05",
  version: 1,
  updatedAt: "2026-05-30T00:00:00.000Z",
  notes: "Built-in fallback selector bundle for V8 supervised filing routes.",
  routeSelectors: {
    simplified_salary_114i: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114i, [data-iris-form='simplified_salary_114i'], [href*='114i'], [id*='114i']",
    },
    normal_individual_114: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114, [data-iris-form='normal_individual_114'], [href*='normal-individual-114'], [id='form-114-original']",
    },
    normal_individual_114_revised: {
      ...COMMON_RETURN_SELECTORS,
      formSelector:
        "#form-114-revised, [data-iris-form='normal_individual_114_revised'], [href*='114'][href*='revised'], [id*='revised-114']",
    },
    wealth_statement: {
      ...COMMON_RETURN_SELECTORS,
      topMenuSelector:
        "#top-menu-wealth-statement, [data-iris-top-menu='wealth_statement'], a[href*='WealthStatement']",
      leftCategorySelector:
        "#left-category-wealth-statement, [data-iris-left-category='wealth_statement'], a[href*='WealthStatement']",
      formSelector:
        "#form-wealth-statement, [data-iris-form='wealth_statement'], [href*='wealth-statement']",
    },
    pre_step_application: {
      ...COMMON_RETURN_SELECTORS,
      topMenuSelector:
        "#top-menu-application, [data-iris-top-menu='application'], a[href*='Application']",
      leftCategorySelector:
        "#left-category-application, [data-iris-left-category='application'], a[href*='Application']",
      formSelector:
        "#form-114i-election, [data-iris-form='pre_step_application'], [href*='114i'][href*='election']",
    },
    // ── Classic Portal (v1 IRIS, PrimeFaces/JSF) ──
    // Accessed after being redirected from the new IRIS portal.
    // Uses left tree navigation (ui-panelmenu) instead of top-menu + left-category.
    // Selectors target text labels rather than IDs because PrimeFaces auto-generates IDs.
    classic_individual_114: {
      // Classic portal has no top menu — this serves as the tree container
      topMenuSelector:
        "#correspondenceTabs\\:returnAmountForm\\:menuPanel, .return-data-left-menu .ui-panelmenu",
      // Classic portal has no left category — this serves as the tree node text matcher
      leftCategorySelector:
        "#correspondenceTabs\\:returnAmountForm\\:j_idt425, .ui-panelmenu",
      // The main form/data area
      formSelector:
        "#correspondenceTabs\\:returnAmountForm\\:data, form[id*='businessFormReturn'], form[id*='returnAmountForm']",
      formReadySelector:
        "#correspondenceTabs\\:returnAmountForm\\:data table.ui-datatable, .ui-datatable-data",
      periodSelector: null,
      nameSelector: null,
      generatePsidSelector: null,
      psidDisplaySelector: null,
      psidDownloadSelector: null,
      cprDisplaySelector: null,
      paidAmountSelector: null,
      balancePayableSelector: null,
      refundBannerSelector: null,
      // Save button on classic portal toolbar
      submitButtonSelector:
        "#correspondence\\:btnSave, button[id*='btnSave'], button[id*='btnSubmit']",
      completionConfirmSelector:
        "#correspondence\\:btnSubmit, button[id*='btnSubmit']",
    },
  },
};

function normalizeHost(value: string) {
  return value.trim().toLowerCase();
}

function splitHosts(value: string | undefined) {
  return (value || "")
    .split(",")
    .map((item) => normalizeHost(item))
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function sanitizeRequiredSelectorValue(value: unknown): string | undefined {
  const safe = sanitizeString(value);
  return safe || undefined;
}

function sanitizeOptionalSelectorValue(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  const safe = sanitizeString(value);
  return safe ?? undefined;
}

function sanitizeRouteSelectorPatch(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const patch: Partial<FbrRouteSelectorConfig> = {};

  for (const key of REQUIRED_SELECTOR_KEYS) {
    const safe = sanitizeRequiredSelectorValue(value[key]);
    if (safe) {
      patch[key] = safe;
    }
  }

  for (const key of OPTIONAL_SELECTOR_KEYS) {
    const safe = sanitizeOptionalSelectorValue(value[key]);
    if (safe !== undefined) {
      patch[key] = safe;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function isIrisRouteFamily(value: unknown): value is IrisRouteFamily {
  return (
    value === "simplified_salary_114i" ||
    value === "normal_individual_114" ||
    value === "normal_individual_114_revised" ||
    value === "classic_individual_114" ||
    value === "wealth_statement" ||
    value === "pre_step_application"
  );
}

function buildSelectorHash(input: { id: string; version: number; routeSelectors: Record<IrisRouteFamily, FbrRouteSelectorConfig> }) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function mergeRouteSelector(
  base: FbrRouteSelectorConfig,
  patch?: Partial<FbrRouteSelectorConfig> | null,
): FbrRouteSelectorConfig {
  if (!patch) {
    return { ...base };
  }

  const next: FbrRouteSelectorConfig = { ...base };

  for (const key of REQUIRED_SELECTOR_KEYS) {
    const value = patch[key];
    if (typeof value === "string" && value.trim()) {
      next[key] = value.trim();
    }
  }

  for (const key of OPTIONAL_SELECTOR_KEYS) {
    const value = patch[key];
    if (value === null) {
      next[key] = null;
    } else if (typeof value === "string" && value.trim()) {
      next[key] = value.trim();
    }
  }

  return next;
}

function buildBundleFromPatch(
  input: {
    id: string;
    version: number;
    updatedAt: string;
    notes: string | null;
    routeSelectorPatches: Partial<Record<IrisRouteFamily, Partial<FbrRouteSelectorConfig>>>;
  },
): FbrSelectorBundleDefinition {
  const routeSelectors: Record<IrisRouteFamily, FbrRouteSelectorConfig> = {
    simplified_salary_114i: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.simplified_salary_114i,
      input.routeSelectorPatches.simplified_salary_114i,
    ),
    normal_individual_114: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.normal_individual_114,
      input.routeSelectorPatches.normal_individual_114,
    ),
    normal_individual_114_revised: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.normal_individual_114_revised,
      input.routeSelectorPatches.normal_individual_114_revised,
    ),
    wealth_statement: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.wealth_statement,
      input.routeSelectorPatches.wealth_statement,
    ),
    pre_step_application: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.pre_step_application,
      input.routeSelectorPatches.pre_step_application,
    ),
    classic_individual_114: mergeRouteSelector(
      DEFAULT_SELECTOR_BUNDLE.routeSelectors.classic_individual_114,
      input.routeSelectorPatches.classic_individual_114,
    ),
  };

  return {
    id: input.id,
    version: input.version,
    updatedAt: input.updatedAt,
    notes: input.notes,
    routeSelectors,
  };
}

function parseSelectorBundleSettings(value: unknown): FbrSelectorBundleSettings | null {
  if (!isRecord(value)) {
    return null;
  }

  const activeBundleId = sanitizeString(value.activeBundleId) ?? undefined;
  const bundles = Array.isArray(value.bundles) ? value.bundles : undefined;

  return {
    activeBundleId,
    bundles,
  };
}

function parseUserBundle(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const id = sanitizeString(value.id);
  if (!id) {
    return null;
  }

  // Reject if routeSelectors is not a valid record (must be an object, not a string/array/null)
  if (!isRecord(value.routeSelectors)) {
    return null;
  }

  const versionCandidate =
    typeof value.version === "number"
      ? value.version
      : typeof value.version === "string"
        ? Number(value.version)
        : Number.NaN;
  const version = Number.isFinite(versionCandidate) ? Math.max(1, Math.floor(versionCandidate)) : 1;
  const updatedAt = sanitizeString(value.updatedAt) || new Date().toISOString();
  const notes = sanitizeString(value.notes);
  const routeSelectorsValue = value.routeSelectors as Record<string, unknown>;
  const routeSelectorPatches: Partial<Record<IrisRouteFamily, Partial<FbrRouteSelectorConfig>>> = {};

  for (const [routeFamily, selectorValue] of Object.entries(routeSelectorsValue)) {
    if (!isIrisRouteFamily(routeFamily)) {
      continue;
    }

    const patch = sanitizeRouteSelectorPatch(selectorValue);
    if (patch) {
      routeSelectorPatches[routeFamily] = patch;
    }
  }

  return buildBundleFromPatch({
    id,
    version,
    updatedAt,
    notes,
    routeSelectorPatches,
  });
}

async function loadSelectorBundleSettingsForUser(userId: string | null | undefined) {
  if (!userId) {
    return null;
  }

  try {
    const settings = await db.userSettings.findUnique({
      where: { userId },
      select: { settingsJson: true },
    });

    if (!settings?.settingsJson) {
      return null;
    }

    const parsed = JSON.parse(settings.settingsJson) as Record<string, unknown>;
    const nestedSettings = parseSelectorBundleSettings(parsed.fbrSelectorConfig);
    if (nestedSettings) {
      return nestedSettings;
    }

    return parseSelectorBundleSettings(parsed.fbrSelectorBundles);
  } catch {
    return null;
  }
}

/**
 * Convert a DB FbrSelectorBundle record into the in-memory FbrSelectorBundleDefinition format.
 */
function parseBundleFromDb(bundle: { id: string; version: number; label?: string | null; notes?: string | null; createdAt: Date; updatedAt: Date; routeSelectors: unknown }): FbrSelectorBundleDefinition | null {
  if (!isRecord(bundle.routeSelectors)) {
    return null;
  }

  const routeSelectorsValue = bundle.routeSelectors as Record<string, unknown>;
  const routeSelectorPatches: Partial<Record<IrisRouteFamily, Partial<FbrRouteSelectorConfig>>> = {};

  for (const [routeFamily, selectorValue] of Object.entries(routeSelectorsValue)) {
    if (!isIrisRouteFamily(routeFamily)) {
      continue;
    }
    const patch = sanitizeRouteSelectorPatch(selectorValue);
    if (patch) {
      routeSelectorPatches[routeFamily] = patch;
    }
  }

  return buildBundleFromPatch({
    id: bundle.id,
    version: bundle.version,
    updatedAt: bundle.updatedAt.toISOString(),
    notes: bundle.notes ?? null,
    routeSelectorPatches,
  });
}

/**
 * Fetch the globally active selector bundle from the database.
 * Returns null if no active deployment exists (falls back to DEFAULT_SELECTOR_BUNDLE).
 */
async function loadGlobalActiveBundle(): Promise<FbrSelectorBundleDefinition | null> {
  try {
    const deployment = await db.fbrBundleDeployment.findFirst({
      where: { status: "active" },
      include: { bundle: true },
      orderBy: { deployedAt: "desc" },
    });

    if (!deployment?.bundle) {
      return null;
    }

    const parsed = parseBundleFromDb(deployment.bundle);
    return parsed;
  } catch {
    // If the table doesn't exist yet (pre-migration), silently fall back
    return null;
  }
}

async function resolveSelectorBundleForUser(userId: string | null | undefined) {
  const cacheKey = userId?.trim() || "__default__";
  const cached = selectorBundleCache.get(cacheKey);
  const now = Date.now();

  if (cached && cached.expiresAt > now) {
    return cached.resolved;
  }

  // ── Phase 17: Global DB bundle as base layer ──
  const globalBundle = await loadGlobalActiveBundle();
  const baseBundle = globalBundle ?? DEFAULT_SELECTOR_BUNDLE;

  const settings = await loadSelectorBundleSettingsForUser(userId);
  const bundleMap = new Map<string, FbrSelectorBundleDefinition>([
    [DEFAULT_SELECTOR_BUNDLE.id, DEFAULT_SELECTOR_BUNDLE],
  ]);

  // If a global DB bundle is active, add it to the map
  if (globalBundle) {
    bundleMap.set(globalBundle.id, globalBundle);
  }

  // Merge user-specific bundles from settingsJson
  for (const item of settings?.bundles ?? []) {
    const parsed = parseUserBundle(item);
    if (parsed) {
      bundleMap.set(parsed.id, parsed);
    }
  }

  // Resolution order:
  // 1. User-specific override (settings.activeBundleId)
  // 2. Globally active DB bundle
  // 3. DEFAULT_SELECTOR_BUNDLE (built-in fallback)
  const preferredBundleId = settings?.activeBundleId;
  const preferredBundle = preferredBundleId ? bundleMap.get(preferredBundleId) : null;
  const activeBundle = preferredBundle ?? baseBundle;

  // Determine source for audit trail
  let source: FbrSelectorBundleSummary["source"] = "default_code";
  if (preferredBundle) {
    source = "user_settings";
  } else if (globalBundle && activeBundle.id === globalBundle.id) {
    source = "global_db";
  }

  const resolved = {
    activeBundle: {
      bundleId: activeBundle.id,
      bundleVersion: activeBundle.version,
      source,
      updatedAt: activeBundle.updatedAt,
      notes: activeBundle.notes,
      hash: buildSelectorHash({
        id: activeBundle.id,
        version: activeBundle.version,
        routeSelectors: activeBundle.routeSelectors,
      }),
    } satisfies FbrSelectorBundleSummary,
    selectorsByRouteFamily: activeBundle.routeSelectors,
  };

  selectorBundleCache.set(cacheKey, {
    expiresAt: now + SELECTOR_CACHE_TTL_MS,
    resolved,
  });

  return resolved;
}

export function clearFbrSelectorBundleCache(userId?: string | null) {
  if (userId) {
    selectorBundleCache.delete(userId.trim() || "__default__");
    return;
  }

  selectorBundleCache.clear();
}

export function getFbrDesktopAuthConfig(): FbrDesktopAuthConfig {
  const useMockIris = (process.env.FBR_USE_MOCK_IRIS?.trim() || "true").toLowerCase() !== "false";
  const loginUrl = process.env.FBR_IRIS_LOGIN_URL?.trim() || "mock-iris://login";

  return {
    loginUrl,
    readySelector: process.env.FBR_IRIS_READY_SELECTOR?.trim() || "#iris-dashboard-ready",
    readyRejectSelector: process.env.FBR_IRIS_READY_REJECT_SELECTOR?.trim() || "#iris-password-reset-required",
    readyUrlPattern: process.env.FBR_IRIS_READY_URL_PATTERN?.trim() || "/dashboard",
    useMockIris,
  };
}

export async function getActiveFbrSelectorBundle(input?: { userId?: string | null }) {
  return resolveSelectorBundleForUser(input?.userId);
}

export async function getRouteSelectorConfig(
  routeFamily: IrisRouteFamily,
  input?: { userId?: string | null },
) {
  const resolved = await resolveSelectorBundleForUser(input?.userId);
  return resolved.selectorsByRouteFamily[routeFamily] ?? null;
}

export async function getFbrPortalAutomationConfig(input?: {
  userId?: string | null;
  routeFamily?: IrisRouteFamily | null;
}): Promise<FbrPortalAutomationConfig> {
  const desktop = getFbrDesktopAuthConfig();
  const allowlist = splitHosts(process.env.FBR_IRIS_HOST_ALLOWLIST);
  const resolvedBundle = await resolveSelectorBundleForUser(input?.userId);
  const routeSelector =
    input?.routeFamily && isIrisRouteFamily(input.routeFamily)
      ? resolvedBundle.selectorsByRouteFamily[input.routeFamily]
      : null;

  if (allowlist.length === 0 && !desktop.useMockIris) {
    allowlist.push("iris.fbr.gov.pk");
  }

  return {
    portalHostAllowlist: allowlist,
    readiness: {
      loginUrl: desktop.loginUrl,
      readySelector: desktop.readySelector,
      readyRejectSelector: desktop.readyRejectSelector,
      readyUrlPattern: desktop.readyUrlPattern,
    },
    dryRun: {
      entryUrl: process.env.FBR_IRIS_DRY_RUN_URL?.trim() || "mock-iris://return",
      reviewGateSelector:
        process.env.FBR_IRIS_REVIEW_GATE_SELECTOR?.trim() || "#dry-run-review-gate",
      finalSubmitSelector:
        process.env.FBR_IRIS_FINAL_SUBMIT_SELECTOR?.trim() || "#final-submit",
      completedTasksSelector:
        process.env.FBR_IRIS_COMPLETED_TASKS_SELECTOR?.trim() || "#completed-tasks-proof",
      pauseReason:
        process.env.FBR_IRIS_DRY_RUN_PAUSE_REASON?.trim() ||
        "Dry-run reached the final review gate. Final submit stays user controlled.",
    },
    assistedFiling: {
      readinessUrl: process.env.FBR_IRIS_ASSISTED_READINESS_URL?.trim() || "mock-iris://dashboard",
      passwordResetUrl: process.env.FBR_IRIS_PASSWORD_RESET_URL?.trim() || "mock-iris://password-reset",
      otpCaptchaUrl: process.env.FBR_IRIS_OTP_CAPTCHA_URL?.trim() || "mock-iris://otp-captcha",
      paymentUrl: process.env.FBR_IRIS_PAYMENT_URL?.trim() || "mock-iris://payment",
      finalReviewUrl: process.env.FBR_IRIS_FINAL_REVIEW_URL?.trim() || "mock-iris://final-review",
      completedTasksUrl: process.env.FBR_IRIS_COMPLETED_TASKS_URL?.trim() || "mock-iris://completed",
    },
    // Phase 15.5c F9: Classic portal (PrimeFaces/JSF) assisted filing URLs.
    // No mid-filing password reset, OTP, or PSID. Instead: save→submit→
    // confirm dialog→rule engine→PIN entry→proof capture.
    classicAssistedFiling: {
      finalReviewUrl: process.env.FBR_IRIS_CLASSIC_FINAL_REVIEW_URL?.trim() || "mock-iris://classic-portal",
      pinEntryUrl: process.env.FBR_IRIS_CLASSIC_PIN_URL?.trim() || "mock-iris://classic-pin",
      completedTasksUrl: process.env.FBR_IRIS_CLASSIC_COMPLETED_TASKS_URL?.trim() || "mock-iris://classic-fixed-final-tax",
    },
    routeSelector,
    selectorBundle: resolvedBundle.activeBundle,
    useMockIris: desktop.useMockIris,
  };
}

export async function listFbrSelectorBundles(input?: { userId?: string | null }) {
  const resolved = await resolveSelectorBundleForUser(input?.userId);
  return {
    activeBundle: resolved.activeBundle,
    routeFamilies: ALL_ROUTE_FAMILIES,
  };
}

// ── Phase 19.8: Selector Fallback Chain Builder ──

/** A single selector entry with priority and context */
export type SelectorFallbackEntry = {
  /** The CSS selector string */
  selector: string;
  /** Priority: 0 = primary, 1+ = fallback (higher = lower priority) */
  priority: number;
  /** Human-readable label for diagnostics */
  label: string;
};

/** Fallback chain for a single action within a route family */
export type SelectorFallbackChain = {
  routeFamily: IrisRouteFamily;
  action: keyof FbrRouteSelectorConfig;
  primary: SelectorFallbackEntry;
  fallbacks: SelectorFallbackEntry[];
};

/**
 * Build a priority-ordered fallback chain for each selector action
 * in a given route family.
 *
 * The chain is used by the Electron agent's `trySelectorsInPriority()`
 * to attempt selectors in order, falling back when the primary fails.
 *
 * Fallback generation strategies:
 *   1. Comma-separated multi-selector: primary selector is split on comma
 *   2. Attribute-based alternatives: e.g. `#id` → `[data-*]` variants
 *   3. PrimeFaces JSF ID alternatives: colon-escaped IDs → unescaped
 *   4. Text-content selectors: generated from the action name
 *
 * @param routeFamily - The IRIS route family
 * @param routeSelector - The route selector config (from the active bundle)
 * @returns Array of fallback chains, one per action
 */
export function buildSelectorFallbackChains(
  routeFamily: IrisRouteFamily,
  routeSelector: FbrRouteSelectorConfig,
): SelectorFallbackChain[] {
  const allKeys = [...REQUIRED_SELECTOR_KEYS, ...OPTIONAL_SELECTOR_KEYS] as Array<keyof FbrRouteSelectorConfig>;
  const chains: SelectorFallbackChain[] = [];

  for (const action of allKeys) {
    const primaryValue = routeSelector[action];
    if (!primaryValue) continue; // Skip null/undefined selectors (e.g., periodSelector for classic)

    const entries: SelectorFallbackEntry[] = [];

    // Strategy 1: Split comma-separated selectors into individual entries
    const parts = primaryValue.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      entries.push({
        selector: parts[i],
        priority: i,
        label: i === 0 ? `${action} (primary #${i + 1})` : `${action} (fallback from multi-selector #${i + 1})`,
      });
    }

    // Strategy 2: For ID-based selectors, generate data-attribute alternatives
    const idMatch = parts[0]?.match(/#([a-zA-Z][\w-]*)/);
    if (idMatch) {
      const idName = idMatch[1];
      entries.push({
        selector: `[data-iris-${action.replace(/Selector$/, "")}="${idName}"]`,
        priority: entries.length,
        label: `${action} (data-attribute fallback)`,
      });
      entries.push({
        selector: `[id*="${idName}"]`,
        priority: entries.length + 1,
        label: `${action} (partial-id fallback)`,
      });
    }

    // Strategy 3: For PrimeFaces/JSF colon-escaped IDs, generate unescaped alternatives
    if (primaryValue.includes("\\\\:")) {
      const unescaped = primaryValue.replace(/\\\\:/g, ":");
      entries.push({
        selector: unescaped,
        priority: entries.length,
        label: `${action} (unescaped JSF ID fallback)`,
      });
    }

    // Strategy 4: Text-content-based fallbacks for tree navigation
    if (action === "formSelector" || action === "formReadySelector") {
      entries.push({
        selector: `.ui-datatable, table[role="grid"]`,
        priority: entries.length,
        label: `${action} (generic data table fallback)`,
      });
      entries.push({
        selector: `form[id*="Form"]:not([id*="header"]), form[id*="form"]:not([id*="header"])`,
        priority: entries.length + 1,
        label: `${action} (generic form fallback)`,
      });
    }

    if (action === "submitButtonSelector") {
      entries.push({
        selector: `button[id*="Save"], button[id*="save"], button[id*="Submit"], button[id*="submit"]`,
        priority: entries.length,
        label: `${action} (generic save/submit button fallback)`,
      });
      entries.push({
        selector: `input[type="submit"], button[type="submit"]`,
        priority: entries.length + 1,
        label: `${action} (HTML submit fallback)`,
      });
    }

    const primary = entries[0];
    const fallbacks = entries.slice(1);

    chains.push({
      routeFamily,
      action,
      primary,
      fallbacks,
    });
  }

  return chains;
}

/**
 * Build fallback chains for ALL route families in a bundle.
 * Returns a flat map of routeFamily → chains[].
 */
export function buildAllFallbackChains(
  routeSelectors: Record<IrisRouteFamily, FbrRouteSelectorConfig>,
): Map<IrisRouteFamily, SelectorFallbackChain[]> {
  const allChains = new Map<IrisRouteFamily, SelectorFallbackChain[]>();

  for (const routeFamily of ALL_ROUTE_FAMILIES) {
    const selector = routeSelectors[routeFamily];
    if (selector) {
      allChains.set(routeFamily, buildSelectorFallbackChains(routeFamily, selector));
    }
  }

  return allChains;
}

/**
 * Serialize fallback chains to JSON for transmission to the Electron agent.
 */
export function serializeFallbackChainsForAgent(
  chains: Map<IrisRouteFamily, SelectorFallbackChain[]>,
): Record<string, Array<{ action: string; primary: string; fallbacks: string[] }>> {
  const serialized: Record<string, Array<{ action: string; primary: string; fallbacks: string[] }>> = {};

  for (const [routeFamily, chainList] of chains) {
    serialized[routeFamily] = chainList.map((chain) => ({
      action: chain.action,
      primary: chain.primary.selector,
      fallbacks: chain.fallbacks.map((f) => f.selector),
    }));
  }

  return serialized;
}

// ─── Phase 19.9: Dual Automation Strategy (IRIS-6 / Misalignment #6) ─

/**
 * Automation action type — the kinds of actions the bot can perform
 * on the IRIS portal.
 */
export type IrisAutomationActionType =
  | "navigate_menu"       // Click a left-panel menu item
  | "fill_field"          // Fill a form field / data table cell
  | "open_dialog"         // Open a dialog (asset entry, etc.)
  | "close_dialog"        // Close / confirm a dialog
  | "save"                // Save the return
  | "submit"              // Submit the return
  | "confirm_submit"      // Confirm the submission dialog
  | "enter_pin";          // Enter PIN for classic portal

/**
 * A single automation step the bot should execute.
 */
export type IrisAutomationStep = {
  /** Human-readable label for logging/diagnostics */
  label: string;
  /** The type of action */
  action: IrisAutomationActionType;
  /** The CSS selector or JS expression to use */
  target: string;
  /** Optional value to fill (for fill_field actions) */
  value?: string;
  /** For JSF DataTable: which column to fill (DH0=total, DH1=exempt, DH2=taxable) */
  jsfColumn?: "total" | "exempt" | "taxable";
  /** For JSF DataTable: which row index (0-based) */
  jsfRowIndex?: number;
  /** Priority within the step sequence (lower = earlier) */
  priority: number;
  /** Which portal technology this step targets */
  portalType: IrisPortalType;
};

/**
 * Automation playbook for a single income/deduction/WHT category.
 *
 * Contains all the automation steps needed to fill that category
 * in the IRIS portal, with portal-specific variants.
 */
export type IrisCategoryAutomationPlaybook = {
  /** The registry category key this playbook is for */
  categoryKey: string;
  /** Human-readable category label */
  categoryLabel: string;
  /** The IRIS menu ID (e.g., "menu_3129") */
  irisMenuId: string;
  /** The IRIS section label */
  irisSection: string;
  /** Which portal(s) this category appears in */
  portalType: IrisPortalType;
  /** Steps to navigate to this category's section */
  navigateSteps: IrisAutomationStep[];
  /** Steps to fill the data for this category */
  fillSteps: IrisAutomationStep[];
  /** Tax treatment (drives DH0/DH1/DH2 column assignment) */
  taxTreatment: TaxTreatment;
};

// ─── IRIS Portal Type (re-exported from above, used by automation) ───

/**
 * Build the PrimeFaces.ab() JS invocation string for clicking a
 * classic portal (irisv1) left-panel menu item.
 *
 * Pattern verified against 36 IRIS DOM captures.
 * See: OG Plan V12.2 §8.1.2 (menu tree) and §8.4.2 (automation playbook)
 */
export function buildPrimeFacesMenuClick(menuId: string): string {
  // Escape colons for JS string if needed — the menuId should NOT contain
  // colons (it's the raw "menu_NNNN" value)
  const safeMenuId = menuId.replace(/[^a-zA-Z0-9_-]/g, "");
  return [
    `PrimeFaces.ab({`,
    `  s:"correspondenceTabs:returnAmountForm:${safeMenuId}",`,
    `  u:"correspondenceTabs:returnAmountForm:dropDown correspondenceTabs:returnAmountForm:showCalculateButtonPnl correspondenceTabs:returnAmountForm:data correspondenceTabs:returnAmountForm:menuPanel",`,
    `  ps:true,`,
    `  f:"correspondenceTabs:returnAmountForm"`,
    `});`,
  ].join("");
}

/**
 * Build a CSS selector for a JSF DataTable cell in the classic portal.
 *
 * Classic portal uses row-indexed inputs:
 *   #correspondenceTabs\\:returnAmountForm\\:data\\:N\\:total   (DH0)
 *   #correspondenceTabs\\:returnAmountForm\\:data\\:N\\:exempt  (DH1)
 *   #correspondenceTabs\\:returnAmountForm\\:data\\:N\\:taxable (DH2)
 */
export function buildJsfDataTableCellSelector(
  rowIndex: number,
  column: "total" | "exempt" | "taxable",
): string {
  return `#correspondenceTabs\\:returnAmountForm\\:data\\:${rowIndex}\\:${column}`;
}

/**
 * Build the PrimeFaces.widgetVar.show() JS invocation for opening
 * a dialog in the classic portal.
 *
 * Known dialog widget variables (from IRIS DOM capture):
 *   referProperty1Dlg, referPropertyLocalDlg, referPropertyForeignDlg,
 *   referBankAccountDlg, referInvestmentDlg,
 *   dlgVehicle, dlgPlantMachinary, dlgHouseHoldEffects,
 *   dlgPreciousPossessions, dlgLifeStock,
 *   dlgDebit, dlgCredit, dlgNonResident,
 *   dlgBusinessReturn, dlgForeignBusiness
 */
export function buildPrimeFacesDialogOpen(widgetVar: string): string {
  const safeVar = widgetVar.replace(/[^a-zA-Z0-9_]/g, "");
  return `PF('${safeVar}').show();`;
}

/**
 * Build the PrimeFaces.ab() JS invocation for a classic portal
 * toolbar button (Save, Submit, Cancel, Edit).
 */
export function buildPrimeFacesToolbarAction(
  action: "save" | "submit" | "cancel" | "edit",
): string {
  const sourceMap: Record<string, string> = {
    edit: "correspondence:edit",
    save: "correspondence:btnSave",
    submit: "correspondence:btnSubmit",
    cancel: "correspondence:btnCancle",
  };
  const source = sourceMap[action] ?? `correspondence:btn${action.charAt(0).toUpperCase() + action.slice(1)}`;
  return `PrimeFaces.ab({s:"${source}"});`;
}

/**
 * Build the confirmation dialog action for the classic portal.
 *
 * After save:  PF('confirmationSave').show(); → click #correspondence\\:save
 * After submit: PF('confirmationSubmit').show(); → click #correspondence\\:submit
 */
export function buildPrimeFacesConfirmAction(
  confirmType: "save" | "submit",
): { showDialog: string; confirmButton: string } {
  const widgetVar = confirmType === "save" ? "confirmationSave" : "confirmationSubmit";
  const buttonId = confirmType === "save"
    ? `#correspondence\\:save`
    : `#correspondence\\:submit`;
  return {
    showDialog: `PF('${widgetVar}').show();`,
    confirmButton: buttonId,
  };
}

/**
 * Get the correct menu navigation strategy for a category.
 *
 * Returns the automation step(s) to navigate to the category's section
 * in the IRIS portal, differentiated by portal technology:
 *
 * - irisv1 (Classic/PrimeFaces): PrimeFaces.ab() JS invocation
 * - iris2 (Angular SPA): DOM click on menu item
 * - both: Returns both variants; caller picks based on route family
 */
export function buildCategoryMenuNavigateStep(
  category: IncomeCategoryDefinition,
): IrisAutomationStep[] {
  const steps: IrisAutomationStep[] = [];
  const menuId = category.irisMenuId;
  if (!menuId) return steps;

  // Classic portal (irisv1): PrimeFaces.ab() — the primary mechanism
  if (category.irisPortalType === "irisv1" || category.irisPortalType === "both") {
    steps.push({
      label: `Navigate to ${category.label} via PrimeFaces menu click (${menuId})`,
      action: "navigate_menu",
      target: buildPrimeFacesMenuClick(menuId),
      priority: 0,
      portalType: "irisv1",
    });
  }

  // IRIS 2.0 (Angular SPA): DOM click on menu element
  if (category.irisPortalType === "iris2" || category.irisPortalType === "both") {
    steps.push({
      label: `Navigate to ${category.label} via DOM click (${menuId})`,
      action: "navigate_menu",
      target: `document.querySelector('[id$="${menuId}"]').click();`,
      priority: category.irisPortalType === "both" ? 1 : 0,
      portalType: "iris2",
    });
  }

  return steps;
}

/**
 * Get the correct field-filling strategy for a category.
 *
 * For classic portal (irisv1): Uses JSF DataTable row-indexed inputs
 *   with DH0 (total), DH1 (exempt/final), DH2 (taxable) columns.
 * For IRIS 2.0 (iris2): Uses Angular formControlName attribute.
 *
 * The taxTreatment determines which columns get which values:
 *   - progressive_slab: DH0=full amount, DH1=0, DH2=full amount
 *   - final_tax:        DH0=full amount, DH1=full amount, DH2=0
 *   - exempt:           DH0=full amount, DH1=full amount, DH2=0
 */
export function buildCategoryFieldFillSteps(
  category: IncomeCategoryDefinition,
  amount: number,
  rowIndex: number,
): IrisAutomationStep[] {
  const steps: IrisAutomationStep[] = [];
  const treatment: TaxTreatment = category.taxTreatment;
  const amountStr = String(Math.round(amount));

  // Classic portal (irisv1): DataTable row-indexed inputs
  if (category.irisPortalType === "irisv1" || category.irisPortalType === "both") {
    // DH0 — Total Amount / Receipts / Value (always filled)
    steps.push({
      label: `Fill ${category.label} DH0 (total): ${amountStr}`,
      action: "fill_field",
      target: buildJsfDataTableCellSelector(rowIndex, "total"),
      value: amountStr,
      jsfColumn: "total",
      jsfRowIndex: rowIndex,
      priority: 0,
      portalType: "irisv1",
    });

    if (treatment === "final_tax" || treatment === "exempt") {
      // DH1 — Exempt / Fixed-Final Tax (full amount for final-tax & exempt)
      steps.push({
        label: `Fill ${category.label} DH1 (exempt/final): ${amountStr}`,
        action: "fill_field",
        target: buildJsfDataTableCellSelector(rowIndex, "exempt"),
        value: amountStr,
        jsfColumn: "exempt",
        jsfRowIndex: rowIndex,
        priority: 1,
        portalType: "irisv1",
      });
      // DH2 — Must be explicitly zeroed (JSF may carry over prior row values)
      steps.push({
        label: `Zero ${category.label} DH2 (taxable) — final/exempt income`,
        action: "fill_field",
        target: buildJsfDataTableCellSelector(rowIndex, "taxable"),
        value: "0",
        jsfColumn: "taxable",
        jsfRowIndex: rowIndex,
        priority: 2,
        portalType: "irisv1",
      });
    } else {
      // DH2 — Subject to Normal Tax (full amount for progressive-slab)
      steps.push({
        label: `Fill ${category.label} DH2 (taxable): ${amountStr}`,
        action: "fill_field",
        target: buildJsfDataTableCellSelector(rowIndex, "taxable"),
        value: amountStr,
        jsfColumn: "taxable",
        jsfRowIndex: rowIndex,
        priority: 1,
        portalType: "irisv1",
      });
      // DH1 — Must be explicitly zeroed (JSF may carry over prior row values)
      steps.push({
        label: `Zero ${category.label} DH1 (exempt) — progressive-slab income`,
        action: "fill_field",
        target: buildJsfDataTableCellSelector(rowIndex, "exempt"),
        value: "0",
        jsfColumn: "exempt",
        jsfRowIndex: rowIndex,
        priority: 2,
        portalType: "irisv1",
      });
    }
  }

  // IRIS 2.0 (Angular SPA): formControlName-based
  if (category.irisPortalType === "iris2" || category.irisPortalType === "both") {
    const basePriority = category.irisPortalType === "both" ? 2 : 0;
    steps.push({
      label: `Fill ${category.label} via Angular formControlName: ${amountStr}`,
      action: "fill_field",
      target: `[formControlName="${category.key}"]`,
      value: amountStr,
      priority: basePriority,
      portalType: "iris2",
    });
  }

  return steps;
}

/**
 * Build the full automation playbook for a single category.
 *
 * This assembles navigation + field-fill steps into a complete
 * playbook that the automation bot can execute.
 *
 * @param category - The registry category definition
 * @param amount - The amount to fill (in PKR)
 * @param rowIndex - The DataTable row index (for classic portal); 0-based
 * @param additionalSteps - Any extra steps (e.g., dialog open/close for assets)
 */
export function buildCategoryAutomationPlaybook(
  category: IncomeCategoryDefinition,
  amount: number,
  rowIndex: number,
  additionalSteps: IrisAutomationStep[] = [],
): IrisCategoryAutomationPlaybook {
  const navigateSteps = buildCategoryMenuNavigateStep(category);
  const fillSteps = buildCategoryFieldFillSteps(category, amount, rowIndex);

  return {
    categoryKey: category.key,
    categoryLabel: category.label,
    irisMenuId: category.irisMenuId ?? "",
    irisSection: category.irisSection ?? category.label,
    portalType: category.irisPortalType ?? "iris2",
    navigateSteps,
    fillSteps: [...fillSteps, ...additionalSteps],
    taxTreatment: category.taxTreatment,
  };
}

/**
 * Get the correct submit action for a route family.
 *
 * Classic portal (irisv1): PrimeFaces.ab({s:"correspondence:btnSubmit"})
 * IRIS 2.0 (iris2): button[data-action='submit-return'] click
 */
export function buildSubmitAction(routeFamily: IrisRouteFamily): IrisAutomationStep {
  const portalType = getPortalTypeForRouteFamily(routeFamily);

  if (portalType === "irisv1") {
    return {
      label: "Submit return via PrimeFaces.ab (classic portal)",
      action: "submit",
      target: buildPrimeFacesToolbarAction("submit"),
      priority: 0,
      portalType: "irisv1",
    };
  }

  return {
    label: "Submit return via DOM click (IRIS 2.0)",
    action: "submit",
    target: `document.querySelector('button[data-action="submit-return"], button[type="submit"]').click();`,
    priority: 0,
    portalType: "iris2",
  };
}

/**
 * Get the correct save action for a route family.
 */
export function buildSaveAction(routeFamily: IrisRouteFamily): IrisAutomationStep {
  const portalType = getPortalTypeForRouteFamily(routeFamily);

  if (portalType === "irisv1") {
    return {
      label: "Save return via PrimeFaces.ab (classic portal)",
      action: "save",
      target: buildPrimeFacesToolbarAction("save"),
      priority: 0,
      portalType: "irisv1",
    };
  }

  return {
    label: "Save return via DOM click (IRIS 2.0)",
    action: "save",
    target: `document.querySelector('button[data-action="save-return"], button[id*="Save"]').click();`,
    priority: 0,
    portalType: "iris2",
  };
}

/**
 * Get the correct confirmation action for a route family.
 *
 * Classic portal: PF('confirmationSubmit').show() → click confirm button
 * IRIS 2.0: Handle Angular Material dialog
 */
export function buildConfirmAction(
  routeFamily: IrisRouteFamily,
  confirmType: "save" | "submit" = "submit",
): IrisAutomationStep[] {
  const portalType = getPortalTypeForRouteFamily(routeFamily);

  if (portalType === "irisv1") {
    const { showDialog, confirmButton } = buildPrimeFacesConfirmAction(confirmType);
    return [
      {
        label: `Show ${confirmType} confirmation dialog (classic portal)`,
        action: "open_dialog",
        target: showDialog,
        priority: 0,
        portalType: "irisv1",
      },
      {
        label: `Click ${confirmType} confirm button (classic portal)`,
        action: "confirm_submit",
        target: `document.querySelector('${confirmButton}').click();`,
        priority: 1,
        portalType: "irisv1",
      },
    ];
  }

  return [
    {
      label: `Confirm ${confirmType} via Angular Material dialog (IRIS 2.0)`,
      action: "confirm_submit",
      target: `document.querySelector('.mat-dialog-actions button[color="primary"], button[data-action="confirm-${confirmType}"]').click();`,
      priority: 0,
      portalType: "iris2",
    },
  ];
}

/**
 * Build the classic portal PIN entry step.
 *
 * After submit confirmation, the classic portal shows a 4-digit PIN
 * entry dialog. The PIN is provided by the user via the Tax Rocket UI.
 */
export function buildClassicPinEntryStep(pin: string): IrisAutomationStep {
  return {
    label: "Enter 4-digit PIN in classic portal dialog",
    action: "enter_pin",
    target: `#correspondence\\:pinInput, input[id*="pin"], input[id*="Pin"]`,
    value: pin,
    priority: 0,
    portalType: "irisv1",
  };
}

/**
 * Build all automation steps needed to fill a complete return
 * across all applicable categories.
 *
 * This is the top-level entry point for the automation bot.
 * It produces a flat, priority-ordered list of steps that covers:
 * 1. Navigate to edit mode (classic portal only)
 * 2. For each category: navigate menu → fill fields
 * 3. Save the return
 * 4. Submit the return
 * 5. Confirm submission
 *
 * @param routeFamily - The IRIS route family
 * @param categories - Array of { category, amount, rowIndex } to fill
 * @returns Priority-ordered automation steps
 */
export function buildFullReturnAutomationPlaybook(
  routeFamily: IrisRouteFamily,
  categories: Array<{
    category: IncomeCategoryDefinition;
    amount: number;
    rowIndex: number;
  }>,
): IrisAutomationStep[] {
  const steps: IrisAutomationStep[] = [];
  const portalType = getPortalTypeForRouteFamily(routeFamily);
  let priority = 0;

  // Step 0: Enable edit mode (classic portal only)
  if (portalType === "irisv1") {
    steps.push({
      label: "Enable edit mode (classic portal)",
      action: "navigate_menu",
      target: buildPrimeFacesToolbarAction("edit"),
      priority: priority++,
      portalType: "irisv1",
    });
  }

  // Step 1-N: For each category, navigate + fill
  for (const { category, amount, rowIndex } of categories) {
    // Only include steps for the relevant portal type
    const navSteps = buildCategoryMenuNavigateStep(category).filter(
      (s) => s.portalType === portalType || s.portalType === "both",
    );
    for (const step of navSteps) {
      steps.push({ ...step, priority: priority++ });
    }

    const fillSteps = buildCategoryFieldFillSteps(category, amount, rowIndex).filter(
      (s) => s.portalType === portalType || s.portalType === "both",
    );
    for (const step of fillSteps) {
      steps.push({ ...step, priority: priority++ });
    }
  }

  // Step N+1: Save
  steps.push({ ...buildSaveAction(routeFamily), priority: priority++ });

  // Step N+2: Submit
  steps.push({ ...buildSubmitAction(routeFamily), priority: priority++ });

  // Step N+3: Confirm
  const confirmSteps = buildConfirmAction(routeFamily, "submit");
  for (const step of confirmSteps) {
    steps.push({ ...step, priority: priority++ });
  }

  // Step N+4: PIN entry (classic portal only — appears after confirm dialog)
  if (portalType === "irisv1") {
    steps.push({
      ...buildClassicPinEntryStep(""), // PIN filled by user at runtime
      label: "Enter 4-digit PIN (classic portal — user-provided)",
      priority: priority++,
    });
  }

  return steps.sort((a, b) => a.priority - b.priority);
}

/**
 * Build a Wealth Statement (section 116) automation playbook
 * for the classic portal.
 *
 * Wealth Statement uses 22 distinct PrimeFaces dialogs for asset/liability
 * entry. Each asset type has its own dialog widget variable.
 *
 * @param assets - Array of { widgetVar, fieldValues } for each asset to add
 * @returns Automation steps for the wealth statement section
 */
export function buildWealthStatementPlaybook(
  assets: Array<{
    widgetVar: string;
    label: string;
    fieldValues: Record<string, string>;
  }>,
): IrisAutomationStep[] {
  const steps: IrisAutomationStep[] = [];
  let priority = 0;

  // Navigate to Wealth Statement → Personal Assets / Liabilities (menu_7004)
  steps.push({
    label: "Navigate to Personal Assets / Liabilities (menu_7004)",
    action: "navigate_menu",
    target: buildPrimeFacesMenuClick("menu_7004"),
    priority: priority++,
    portalType: "irisv1",
  });

  // For each asset: open dialog → fill fields → close/OK
  for (const asset of assets) {
    steps.push({
      label: `Open dialog: ${asset.label} (${asset.widgetVar})`,
      action: "open_dialog",
      target: buildPrimeFacesDialogOpen(asset.widgetVar),
      priority: priority++,
      portalType: "irisv1",
    });

    for (const [fieldSelector, value] of Object.entries(asset.fieldValues)) {
      steps.push({
        label: `Fill ${asset.label}: ${fieldSelector} = ${value}`,
        action: "fill_field",
        target: fieldSelector,
        value,
        priority: priority++,
        portalType: "irisv1",
      });
    }

    // OK button for the dialog — selector varies by dialog
    steps.push({
      label: `Confirm ${asset.label} dialog (OK)`,
      action: "close_dialog",
      target: `document.querySelector('#correspondenceTabs\\:addEditResource2FormLocalReturn\\:j_idt2215, button[id*="j_idt2215"]').click();`,
      priority: priority++,
      portalType: "irisv1",
    });
  }

  return steps;
}
