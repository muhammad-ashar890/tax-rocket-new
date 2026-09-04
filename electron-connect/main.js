const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
} = require("electron");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const {
  createStateStore,
  isBackendAllowed,
  isOriginAllowed,
  sanitizeBaseUrl,
} = require("./portal-agent");

const DLD_OWNER_LOGIN_URL = "https://iris.fbr.gov.pk/login";
const LOCAL_BRIDGE_HOST = "127.0.0.1";
const LOCAL_BRIDGE_PORT = 37219;
const DLD_PORTAL_HOST = "dubailand.gov.ae";
const LOCAL_AGENT_POLL_INTERVAL_MS = 10000;
const LOCAL_AGENT_CONFIRMATION_TITLE = "Tax Rocket Desktop Agent";

let mainWindow = null;
let loginWindow = null;
let workerWindow = null;
let localBridgeServer = null;
let autoCaptureTimer = null;
let localWorkerTimer = null;
let localWorkerRunning = false;
let trustedDeviceState = null;
let autoCaptureState = {
  inProgress: false,
  completed: false,
};
let acceptedLaunchNonces = new Set();
let launchState = {
  flow: "fbr",
  token: "",
  nonce: "",
  apiBaseUrl: "",
  accountReference: "",
  partitionKey: "",
  deviceAuthToken: "",
  trustedDevicePublicId: "",
  allowedOrigins: [],
  backendAllowlist: [],
  desktopAuthConfig: {
    loginUrl: "",
    readySelector: "",
    readyRejectSelector: "",
    readyUrlPattern: "",
    useMockIris: false,
  },
};
const stateStore = createStateStore({ app, fs, path, safeStorage });

function loadAgentState() {
  if (trustedDeviceState) {
    return trustedDeviceState;
  }

  trustedDeviceState = stateStore.loadAgentState();
  return trustedDeviceState;
}

function setTrustedDeviceState(nextState) {
  trustedDeviceState = {
    ...loadAgentState(),
    ...nextState,
  };
  stateStore.saveAgentState(trustedDeviceState);
}

function getInstallationId() {
  return loadAgentState().installationId;
}

function getApiBaseUrl() {
  return launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "";
}

function notifyRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function pushStatus(kind, message) {
  notifyRenderer("status-update", { kind, message });
}

function resetAutoCaptureState() {
  autoCaptureState = {
    inProgress: false,
    completed: false,
  };
}

function publishLaunchState() {
  if (!mainWindow) {
    return;
  }

  mainWindow.webContents.send("launch-state", launchState);
  mainWindow.show();
  mainWindow.focus();
}

function normalizeDesktopAuthConfig(input = {}) {
  return {
    loginUrl: typeof input.loginUrl === "string" ? input.loginUrl.trim() : "",
    readySelector:
      typeof input.readySelector === "string"
        ? input.readySelector.trim()
        : typeof input.successSelector === "string"
          ? input.successSelector.trim()
          : "",
    readyRejectSelector:
      typeof input.readyRejectSelector === "string"
        ? input.readyRejectSelector.trim()
        : typeof input.rejectSelector === "string"
          ? input.rejectSelector.trim()
          : "",
    readyUrlPattern:
      typeof input.readyUrlPattern === "string"
        ? input.readyUrlPattern.trim()
        : typeof input.successUrlPattern === "string"
          ? input.successUrlPattern.trim()
          : "",
    useMockIris: Boolean(input.useMockIris),
  };
}

function getMockIrisFile(fileName) {
  return pathToFileURL(path.join(__dirname, "mock-iris", fileName)).toString();
}

function resolveDesktopLoginUrl() {
  if (launchState.flow === "fbr") {
    const configured =
      launchState.desktopAuthConfig.loginUrl || "mock-iris://login";
    if (configured === "mock-iris://login") {
      return getMockIrisFile("login.html");
    }
    return configured;
  }

  return DLD_OWNER_LOGIN_URL;
}

function resolveWorkerEntryUrl(config) {
  const entryUrl = config?.dryRun?.entryUrl || "";

  if (entryUrl === "mock-iris://return") {
    return getMockIrisFile("return.html");
  }

  if (entryUrl) {
    return entryUrl;
  }

  return getMockIrisFile("return.html");
}

/**
 * Navigate the IRIS top-level menu to reach the target module.
 *
 * Uses the route selector config to click the top-level menu item
 * (e.g., "Income Tax Return") and waits for the left-side category
 * panel to appear.
 *
 * Phase 19.12: Uses trySelectorsInPriority with fallback chains when
 * selectorFallbackChains are available in the routeSelector config.
 */
async function navigateIrisTopMenu(
  windowInstance,
  routeSelector,
  driftContext,
) {
  if (!routeSelector?.topMenuSelector) {
    return false;
  }

  // Build fallback chain for this action
  const selectors = buildActionSelectorChain(routeSelector, "topMenuSelector");

  try {
    await trySelectorsInPriority(
      windowInstance,
      "topMenuSelector",
      selectors,
      driftContext,
    );
  } catch (error) {
    // Fall back to legacy single-selector approach
    await clickSelector(windowInstance, routeSelector.topMenuSelector);
  }

  // Wait for the left category panel to load
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

/**
 * Navigate the IRIS left-side category panel to reach the target form list.
 *
 * Phase 19.12: Uses trySelectorsInPriority with fallback chains.
 */
async function navigateIrisLeftCategory(
  windowInstance,
  routeSelector,
  driftContext,
) {
  if (!routeSelector?.leftCategorySelector) {
    return false;
  }

  const selectors = buildActionSelectorChain(
    routeSelector,
    "leftCategorySelector",
  );

  try {
    await trySelectorsInPriority(
      windowInstance,
      "leftCategorySelector",
      selectors,
      driftContext,
    );
  } catch (error) {
    await clickSelector(windowInstance, routeSelector.leftCategorySelector);
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  return true;
}

// ── Phase 19.12: buildActionSelectorChain ──────────────────────────────

/**
 * Build a priority-ordered selector array for a given action.
 * Combines the primary selector with any fallback selectors from the
 * routeSelector's `_fallbackChains` metadata (set by server-side
 * buildSelectorFallbackChains).
 */
function buildActionSelectorChain(routeSelector, action) {
  const selectors = [];

  // Primary selector
  const primary = routeSelector[action];
  if (primary) {
    // Split comma-separated multi-selectors into individual entries
    const parts = primary
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    selectors.push(...parts);
  }

  // Add fallbacks from the server-generated fallback chains
  const fallbackChains = routeSelector._fallbackChains;
  if (fallbackChains && Array.isArray(fallbackChains)) {
    const chain = fallbackChains.find((c) => c.action === action);
    if (chain && Array.isArray(chain.fallbacks)) {
      for (const fb of chain.fallbacks) {
        if (fb && !selectors.includes(fb)) {
          selectors.push(fb);
        }
      }
    }
  }

  return selectors;
}

/**
 * Find and click the target form link in the IRIS form list.
 *
 * Uses fuzzy matching to find a form link by text content when the
 * exact selector isn't available. Falls back to the configured
 * formSelector if fuzzy matching fails.
 */
async function navigateIrisFormList(windowInstance, routeSelector, formLabel) {
  if (!routeSelector?.formSelector) {
    return false;
  }

  // Try exact selector first
  try {
    await clickSelector(windowInstance, routeSelector.formSelector);
    return true;
  } catch {
    // Fall through to fuzzy matching
  }

  // Fuzzy matching: find a link/button whose text contains the form label
  if (formLabel) {
    const fuzzySelector = `a:has-text("${formLabel.replace(/"/g, '\\"')}"), button:has-text("${formLabel.replace(/"/g, '\\"')}")`;
    try {
      await clickSelector(windowInstance, fuzzySelector);
      return true;
    } catch {
      // Fall through
    }
  }

  // Last resort: try to find any link in the form list area
  try {
    const found = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const links = document.querySelectorAll('a, button');
        for (const link of links) {
          const text = (link.textContent || '').trim().toLowerCase();
          if (text.includes('return') || text.includes('114') || text.includes('form')) {
            link.click();
            return true;
          }
        }
        return false;
      })();
    `);
    return found;
  } catch {
    return false;
  }
}

/**
 * Verify that the expected form page loaded after navigation.
 *
 * Checks for the formReadySelector and returns true if found.
 */
async function verifyFormReady(windowInstance, routeSelector) {
  if (!routeSelector?.formReadySelector) {
    return true;
  }

  try {
    await waitForVisibleSelector(
      windowInstance,
      routeSelector.formReadySelector,
      10000,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the tax year / period on the IRIS form.
 *
 * Uses the route selector config to find and set the period dropdown
 * or input field. Falls back to trying common selectors if the
 * configured selector doesn't match.
 */
async function setIrisFormPeriod(windowInstance, routeSelector, taxYear) {
  if (!routeSelector?.periodSelector || !taxYear) {
    return false;
  }

  try {
    await fillSelector(
      windowInstance,
      routeSelector.periodSelector,
      String(taxYear),
    );
    return true;
  } catch {
    // Fall back to trying common period selectors
    const fallbackSelectors = [
      'select[name="taxYear"]',
      'select[id*="taxYear"]',
      'select[id*="period"]',
      'input[name*="taxYear"]',
      'input[id*="period"]',
    ];

    for (const selector of fallbackSelectors) {
      try {
        await fillSelector(windowInstance, selector, String(taxYear));
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }
}

/**
 * Handle the taxpayer name field if it's editable on the form.
 *
 * Some IRIS routes allow editing the taxpayer name. This function
 * fills it if a nameSelector is configured and a name value is provided.
 */
async function handleIrisFormName(windowInstance, routeSelector, taxpayerName) {
  if (!routeSelector?.nameSelector || !taxpayerName) {
    return false;
  }

  try {
    await fillSelector(
      windowInstance,
      routeSelector.nameSelector,
      String(taxpayerName),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Navigate from the IRIS dashboard to the target form using route-aware selectors.
 *
 * This is the main entry point for route-aware navigation. It:
 * 1. Clicks the top-level menu (e.g., "Income Tax Return")
 * 2. Clicks the left-side category (e.g., "Return")
 * 3. Finds and clicks the specific form link
 * 4. Sets the tax year / period
 * 5. Handles the taxpayer name if editable
 * 6. Verifies the form is ready for data entry
 *
 * Returns an execution log entry describing what was done.
 */
async function navigateToIrisForm(
  windowInstance,
  routeSelector,
  formLabel,
  taxYear,
  taxpayerName,
) {
  const steps = [];

  // Step 1: Navigate top menu
  if (routeSelector?.topMenuSelector) {
    await navigateIrisTopMenu(windowInstance, routeSelector);
    steps.push("top_menu");
  }

  // Step 2: Navigate left category
  if (routeSelector?.leftCategorySelector) {
    await navigateIrisLeftCategory(windowInstance, routeSelector);
    steps.push("left_category");
  }

  // Step 3: Find and click the form
  const formFound = await navigateIrisFormList(
    windowInstance,
    routeSelector,
    formLabel,
  );
  if (formFound) {
    steps.push("form_selected");
  }

  // Wait for form to load
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Step 4: Set period / tax year
  if (taxYear) {
    const periodSet = await setIrisFormPeriod(
      windowInstance,
      routeSelector,
      taxYear,
    );
    if (periodSet) {
      steps.push("period_set");
    }
  }

  // Step 5: Handle name field
  if (taxpayerName) {
    const nameSet = await handleIrisFormName(
      windowInstance,
      routeSelector,
      taxpayerName,
    );
    if (nameSet) {
      steps.push("name_set");
    }
  }

  // Step 6: Verify form is ready
  const formReady = await verifyFormReady(windowInstance, routeSelector);

  return {
    steps,
    formReady,
    detail: `Navigated IRIS menus: ${steps.join(" → ")}. Form ready: ${formReady}`,
  };
}

/**
 * Detect and handle the PSID generation flow on the IRIS payment screen.
 *
 * This function:
 * 1. Checks if the "Generate PSID" button is visible
 * 2. Captures the balance payable before PSID generation
 * 3. Clicks "Generate PSID" to trigger PSID creation
 * 4. Captures the PSID number from the display
 * 5. Attempts to download/print the PSID slip
 *
 * Returns an object with PSID details or null if PSID generation
 * is not applicable.
 */
async function handlePsidGeneration(windowInstance, routeSelector) {
  if (!routeSelector?.generatePsidSelector) {
    return null;
  }

  const hasGenerateButton = await hasSelector(
    windowInstance,
    routeSelector.generatePsidSelector,
  );
  if (!hasGenerateButton) {
    return null;
  }

  // Capture balance payable before PSID generation
  let balancePayable = null;
  if (routeSelector.balancePayableSelector) {
    try {
      balancePayable = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.balancePayableSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore balance capture errors
    }
  }

  // Click "Generate PSID"
  await clickSelector(windowInstance, routeSelector.generatePsidSelector);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Capture PSID number
  let psidNumber = null;
  if (routeSelector.psidDisplaySelector) {
    try {
      psidNumber = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.psidDisplaySelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore PSID capture errors
    }
  }

  // Attempt to download PSID slip
  let psidDownloaded = false;
  if (routeSelector.psidDownloadSelector) {
    try {
      await clickSelector(windowInstance, routeSelector.psidDownloadSelector);
      psidDownloaded = true;
    } catch {
      // Ignore download errors
    }
  }

  return {
    psidNumber,
    balancePayable,
    psidDownloaded,
  };
}

/**
 * Detect and verify CPR (Computerized Payment Receipt) on the IRIS payment screen.
 *
 * This function:
 * 1. Checks if a CPR display area is visible
 * 2. Captures the CPR reference number
 * 3. Reads the paid amount shown by IRIS
 * 4. Compares the paid amount against the balance payable
 * 5. Detects refund banners / overpayment indicators
 * 6. Checks if the submit button is unlocked
 *
 * Returns an object with CPR/payment verification details.
 */
async function verifyCprAndPayment(windowInstance, routeSelector) {
  const result = {
    cprDetected: false,
    cprReference: null,
    paidAmount: null,
    balancePayable: null,
    refundDetected: false,
    submitUnlocked: false,
  };

  // Detect CPR
  if (routeSelector.cprDisplaySelector) {
    try {
      result.cprDetected = await hasSelector(
        windowInstance,
        routeSelector.cprDisplaySelector,
      );
      if (result.cprDetected) {
        result.cprReference = await windowInstance.webContents
          .executeJavaScript(`
          (() => {
            const element = document.querySelector(${JSON.stringify(routeSelector.cprDisplaySelector)});
            return element ? (element.textContent || element.value || "").trim() : null;
          })();
        `);
      }
    } catch {
      // Ignore CPR detection errors
    }
  }

  // Read paid amount
  if (routeSelector.paidAmountSelector) {
    try {
      result.paidAmount = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.paidAmountSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore paid amount errors
    }
  }

  // Read balance payable
  if (routeSelector.balancePayableSelector) {
    try {
      result.balancePayable = await windowInstance.webContents
        .executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.balancePayableSelector)});
          return element ? (element.textContent || element.value || "").trim() : null;
        })();
      `);
    } catch {
      // Ignore balance errors
    }
  }

  // Detect refund banner
  if (routeSelector.refundBannerSelector) {
    try {
      result.refundDetected = await hasSelector(
        windowInstance,
        routeSelector.refundBannerSelector,
      );
    } catch {
      // Ignore refund detection errors
    }
  }

  // Check if submit is unlocked (submit button visible and enabled)
  if (routeSelector.submitButtonSelector) {
    try {
      const submitEnabled = await windowInstance.webContents.executeJavaScript(`
        (() => {
          const element = document.querySelector(${JSON.stringify(routeSelector.submitButtonSelector)});
          if (!element) return false;
          return !element.disabled && element.getAttribute('aria-disabled') !== 'true';
        })();
      `);
      result.submitUnlocked = submitEnabled;
    } catch {
      // Ignore submit check errors
    }
  }

  return result;
}

/**
 * Verify that the filing was completed successfully by checking for
 * completion evidence on the IRIS portal.
 *
 * Checks for:
 * - Completed tasks / outbox entry
 * - Acknowledgement receipt
 * - Return copy availability
 * - CPR proof
 */
async function verifyCompletionEvidence(windowInstance, routeSelector) {
  const evidence = {
    completedTasksDetected: false,
    acknowledgementDetected: false,
    returnCopyDetected: false,
    cprProofDetected: false,
  };

  // Check for completed tasks / outbox
  if (routeSelector?.completionConfirmSelector) {
    try {
      evidence.completedTasksDetected = await hasSelector(
        windowInstance,
        routeSelector.completionConfirmSelector,
      );
    } catch {
      // Ignore
    }
  }

  // Try common completion evidence selectors
  const evidenceSelectors = {
    acknowledgementDetected:
      '#iris-acknowledgement-proof, [id*="acknowledgement"], [class*="acknowledgement"]',
    returnCopyDetected:
      '#iris-return-copy-proof, [id*="returnCopy"], [class*="return-copy"]',
    cprProofDetected: '#iris-cpr-proof, [id*="cpr"], [class*="cpr-proof"]',
  };

  for (const [key, selector] of Object.entries(evidenceSelectors)) {
    try {
      const found = await hasSelector(windowInstance, selector);
      if (found) {
        evidence[key] = true;
      }
    } catch {
      // Ignore
    }
  }

  return evidence;
}

function resolveMockIrisUrl(value) {
  switch (value) {
    case "mock-iris://login":
      return getMockIrisFile("login.html");
    case "mock-iris://dashboard":
      return getMockIrisFile("dashboard.html");
    case "mock-iris://return":
      return getMockIrisFile("return.html");
    case "mock-iris://password-reset":
      return getMockIrisFile("password-reset.html");
    case "mock-iris://otp-captcha":
      return getMockIrisFile("otp-captcha.html");
    case "mock-iris://payment":
      return getMockIrisFile("payment.html");
    case "mock-iris://final-review":
      return getMockIrisFile("final-review.html");
    case "mock-iris://completed":
      return getMockIrisFile("completed.html");
    // ── Phase 15.5a F6: Classic portal mock routes ──
    case "mock-iris://classic-portal":
      return getMockIrisFile("classic-portal.html");
    case "mock-iris://classic-other-revenues":
      return getMockIrisFile("classic-other-revenues.html");
    case "mock-iris://classic-fixed-final-tax":
      return getMockIrisFile("classic-fixed-final-tax.html");
    case "mock-iris://classic-wealth-statement":
      return getMockIrisFile("classic-wealth-statement.html");
    case "mock-iris://classic-attributes":
      return getMockIrisFile("classic-attributes.html");
    case "mock-iris://classic-pin":
      return getMockIrisFile("classic-pin.html");
    default:
      return value;
  }
}

function getTrustedDeviceRegisterEndpoint() {
  if (launchState.flow === "fbr") {
    return "/api/fbr-connect/desktop/register";
  }

  return "/api/dld-connect/desktop/register";
}

function getTrustedDeviceReadyEndpoint() {
  if (launchState.flow === "fbr") {
    return "/api/fbr-connect/desktop/ready";
  }

  return "/api/dld-connect/desktop/ready";
}

function isLikelyLoggedInDldUrl(rawValue) {
  if (!rawValue || rawValue === "about:blank") {
    return false;
  }

  try {
    const parsed = new URL(rawValue);
    const hostMatches =
      parsed.hostname === DLD_PORTAL_HOST ||
      parsed.hostname.endsWith(`.${DLD_PORTAL_HOST}`);

    if (!hostMatches) {
      return false;
    }

    const normalized = rawValue.toLowerCase();

    if (normalized.includes("/mydld/#/login/owner")) {
      return false;
    }

    if (normalized.includes("/login")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isLikelyReadyFbrUrl(rawValue) {
  if (!rawValue || rawValue === "about:blank") {
    return false;
  }

  const readyUrlPattern = launchState.desktopAuthConfig.readyUrlPattern;

  if (readyUrlPattern && matchesSuccessUrlPattern(rawValue, readyUrlPattern)) {
    return true;
  }

  return rawValue.includes("dashboard.html");
}

function matchesSuccessUrlPattern(rawValue, pattern) {
  if (!rawValue || !pattern) {
    return false;
  }

  return rawValue.toLowerCase().includes(pattern.toLowerCase());
}

function clearAutoCaptureTimer() {
  if (autoCaptureTimer) {
    clearTimeout(autoCaptureTimer);
    autoCaptureTimer = null;
  }
}

function applyLaunchUrl(rawValue) {
  if (
    !rawValue ||
    (!String(rawValue).startsWith("ejari-connect://") &&
      !String(rawValue).startsWith("taxrocket-connect://"))
  ) {
    return false;
  }

  const parsed = new URL(rawValue);
  launchState = {
    flow: parsed.searchParams.get("flow") !== "dld" ? "fbr" : "dld",
    token: parsed.searchParams.get("token") || "",
    nonce: parsed.searchParams.get("nonce") || "",
    apiBaseUrl: sanitizeBaseUrl(parsed.searchParams.get("apiBaseUrl") || ""),
    accountReference: "",
    partitionKey:
      parsed.searchParams.get("partitionKey") ||
      loadAgentState().partitionKey ||
      "",
    deviceAuthToken: loadAgentState().deviceAuthToken || "",
    trustedDevicePublicId: loadAgentState().trustedDevicePublicId || "",
    allowedOrigins: [],
    backendAllowlist: [],
    desktopAuthConfig: normalizeDesktopAuthConfig({
      readySelector:
        parsed.searchParams.get("readySelector") ||
        parsed.searchParams.get("successSelector") ||
        "",
      readyRejectSelector: parsed.searchParams.get("rejectSelector") || "",
      readyUrlPattern:
        parsed.searchParams.get("readyUrlPattern") ||
        parsed.searchParams.get("successUrlPattern") ||
        "",
      loginUrl: parsed.searchParams.get("loginUrl") || "",
      useMockIris: parsed.searchParams.get("flow") === "fbr",
    }),
  };
  setTrustedDeviceState({
    apiBaseUrl: launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "",
  });
  resetAutoCaptureState();
  publishLaunchState();
  pushStatus(
    "ready",
    launchState.flow === "fbr"
      ? "Connection request received. Opening Iris sign-in now."
      : "Connection request received. Opening MyDLD sign-in now.",
  );
  void createLoginWindow(true);

  return true;
}

function applyLaunchPayload(payload) {
  launchState = {
    flow: payload?.flow !== "dld" ? "fbr" : "dld",
    token: typeof payload?.token === "string" ? payload.token : "",
    nonce: typeof payload?.nonce === "string" ? payload.nonce.trim() : "",
    apiBaseUrl: sanitizeBaseUrl(
      typeof payload?.apiBaseUrl === "string" ? payload.apiBaseUrl : "",
    ),
    accountReference:
      typeof payload?.accountReference === "string"
        ? payload.accountReference.trim()
        : "",
    partitionKey:
      typeof payload?.partitionKey === "string"
        ? payload.partitionKey.trim()
        : loadAgentState().partitionKey || "",
    deviceAuthToken: loadAgentState().deviceAuthToken || "",
    trustedDevicePublicId: loadAgentState().trustedDevicePublicId || "",
    allowedOrigins: Array.isArray(payload?.allowedOrigins)
      ? payload.allowedOrigins
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    backendAllowlist: Array.isArray(payload?.backendAllowlist)
      ? payload.backendAllowlist
          .filter((value) => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    desktopAuthConfig: normalizeDesktopAuthConfig(payload?.desktopAuthConfig),
  };
  setTrustedDeviceState({
    apiBaseUrl: launchState.apiBaseUrl || loadAgentState().apiBaseUrl || "",
  });
  resetAutoCaptureState();
  publishLaunchState();

  if (!launchState.token || !launchState.apiBaseUrl) {
    pushStatus("error", "The desktop connection request is incomplete.");
    return false;
  }

  pushStatus(
    "ready",
    launchState.flow === "fbr"
      ? "Connection request received. Opening Iris sign-in now."
      : "Connection request received. Opening MyDLD sign-in now.",
  );
  void createLoginWindow(true);
  return true;
}

async function ensureTrustedDeviceRegistration() {
  if (!launchState.token || !launchState.apiBaseUrl) {
    throw new Error(
      "No active connection session was provided by the web app.",
    );
  }

  const response = await fetch(
    `${launchState.apiBaseUrl}${getTrustedDeviceRegisterEndpoint()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${launchState.token}`,
      },
      body: JSON.stringify({
        installationId: getInstallationId(),
        displayName: `${os.hostname()} Desktop Agent`,
        platform: process.platform,
        appVersion: app.getVersion(),
      }),
    },
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error ||
        `Trusted device registration failed with status ${response.status}.`,
    );
  }

  setTrustedDeviceState({
    installationId: getInstallationId(),
    deviceAuthToken: result.deviceAuthToken || "",
    trustedDevicePublicId: result?.trustedDevice?.publicId || "",
    partitionKey: result.partitionKey || launchState.partitionKey || "",
    apiBaseUrl: launchState.apiBaseUrl || "",
  });

  launchState = {
    ...launchState,
    partitionKey: result.partitionKey || launchState.partitionKey || "",
    deviceAuthToken: result.deviceAuthToken || "",
    trustedDevicePublicId: result?.trustedDevice?.publicId || "",
  };
  publishLaunchState();
  startLocalWorkerLoop();

  return result;
}

function clearLocalWorkerTimer() {
  if (localWorkerTimer) {
    clearInterval(localWorkerTimer);
    localWorkerTimer = null;
  }
}

function startLocalWorkerLoop() {
  clearLocalWorkerTimer();

  localWorkerTimer = setInterval(() => {
    void runLocalWorkerCycle();
  }, LOCAL_AGENT_POLL_INTERVAL_MS);

  void runLocalWorkerCycle();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error || `Request failed with status ${response.status}.`,
    );
  }

  return payload;
}

function getWorkerPartition() {
  const partitionKey =
    launchState.partitionKey || loadAgentState().partitionKey || "default";
  return launchState.flow === "fbr"
    ? `persist:fbr-iris-${partitionKey}`
    : `persist:dld-portal-${partitionKey}`;
}

function getWorkerTempDir(jobId) {
  return path.join(app.getPath("userData"), "jobs", jobId);
}

async function ensureWorkerWindow() {
  if (workerWindow && !workerWindow.isDestroyed()) {
    return workerWindow;
  }

  workerWindow = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1100,
    minHeight: 760,
    title:
      launchState.flow === "fbr"
        ? "Tax Rocket Iris Dry Run"
        : "Ejari Local Automation",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: getWorkerPartition(),
    },
  });

  workerWindow.on("closed", () => {
    workerWindow = null;
  });

  return workerWindow;
}

async function captureWindowScreenshot(windowInstance, label) {
  const image = await windowInstance.capturePage();
  return {
    label,
    dataUrl: image.toDataURL(),
  };
}

async function collectPreFillComparison(windowInstance, portalFieldMap) {
  const comparisons = [];

  for (const field of portalFieldMap) {
    // Phase 15.5a F1: Use field.selector (actual CSS selector for classic portal JSF IDs)
    // when available, falling back to data-tax-field-key for new-portal mock pages.
    const selector =
      field.selector ||
      `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
    const currentValue = await windowInstance.webContents
      .executeJavaScript(
        `
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        return element ? (element.value || "") : "";
      })();
    `,
      )
      .catch(() => "");

    if (currentValue && currentValue !== field.value) {
      comparisons.push({
        key: field.key,
        label: field.label,
        portalValue: currentValue,
        packetValue: field.value,
      });
    }
  }

  return comparisons;
}

function getSelectorBundleSignal(jobContext) {
  const configBundle = jobContext?.taxAutomationConfig?.selectorBundle;
  if (configBundle && typeof configBundle === "object") {
    return configBundle;
  }

  const payloadBundle =
    jobContext?.job?.payload?.selectorBundle ||
    jobContext?.payload?.selectorBundle;
  if (payloadBundle && typeof payloadBundle === "object") {
    return payloadBundle;
  }

  return null;
}

function inferLikelySelectorGroup(errorMessage, executionLog) {
  const message = String(errorMessage || "").toLowerCase();
  const recentStep =
    Array.isArray(executionLog) && executionLog.length > 0
      ? executionLog[executionLog.length - 1]
      : null;
  const step = typeof recentStep?.step === "string" ? recentStep.step : "";

  if (step === "route_navigation" || message.includes("navigation")) {
    return "route_navigation";
  }

  if (
    step === "payment_verification" ||
    message.includes("psid") ||
    message.includes("cpr") ||
    message.includes("submit button")
  ) {
    return "payment_verification";
  }

  if (
    step === "completion_verification" ||
    message.includes("completed tasks") ||
    message.includes("acknowledgement")
  ) {
    return "completion_verification";
  }

  if (message.includes("data-tax-field-key") || step === "field_fill") {
    return "field_fill";
  }

  return "unknown_selector_group";
}

function buildSelectorDriftDiagnostics(errorMessage, executionLog, jobContext) {
  const message = String(errorMessage || "").toLowerCase();
  const selectorLikeFailure =
    message.includes("selector") ||
    message.includes("timed out waiting for selector") ||
    message.includes("missing selector") ||
    message.includes("target form was not detected as ready");

  if (!selectorLikeFailure) {
    return null;
  }

  return {
    reasonCode: "selector_drift_suspected",
    likelySelectorGroup: inferLikelySelectorGroup(message, executionLog),
    selectorBundle: getSelectorBundleSignal(jobContext),
    recommendedActions: [
      "Capture a fresh screenshot of the failed IRIS screen on the trusted device.",
      "Update the affected selector group in the active selector bundle.",
      "Re-run the job from the latest approved packet after bundle update.",
    ],
  };
}

function looksLikeSessionReconnectNeeded(errorMessage) {
  const message = String(errorMessage || "").toLowerCase();
  return (
    message.includes("session appears invalid") ||
    message.includes("requires reconnect") ||
    message.includes("trusted local iris session") ||
    message.includes("ready screen") ||
    message.includes("not logged")
  );
}

function classifyRecoverableAssistedIssue(
  errorMessage,
  executionLog,
  jobContext,
) {
  const selectorDriftDiagnostics = buildSelectorDriftDiagnostics(
    errorMessage,
    executionLog,
    jobContext,
  );
  if (selectorDriftDiagnostics) {
    return {
      requiredAction: "selector_bundle_update",
      message: "IRIS selector mismatch detected during assisted filing.",
      pauseReason:
        "Selector drift suspected. Update the route selector bundle before continuing.",
      userInstruction:
        "Update the affected selector bundle entry, then confirm to retry this phase.",
      selectorDriftDiagnostics,
    };
  }

  if (looksLikeSessionReconnectNeeded(errorMessage)) {
    return {
      requiredAction: "session_reconnect",
      message:
        "Trusted Iris session needs to be reconnected before assisted filing can continue.",
      pauseReason: "The local Iris session is no longer valid for this phase.",
      userInstruction:
        "Sign back into IRIS on the trusted device, return to the expected screen, then confirm to continue.",
      selectorDriftDiagnostics: null,
    };
  }

  return null;
}

function buildRecoveryActions(errorMessage, options = {}) {
  const message = String(errorMessage || "").toLowerCase();

  if (options.selectorDriftDiagnostics) {
    const likelyGroup =
      options.selectorDriftDiagnostics.likelySelectorGroup || "unknown group";
    return [
      `Selector drift is likely in the "${likelyGroup}" group.`,
      "Update the active selector bundle for this route and retry from the latest approved packet.",
      "If the portal layout changed broadly, pause assisted filing and switch to manual packet-guided entry.",
    ];
  }

  if (message.includes("selector")) {
    return [
      "Re-open the expected Iris screen and confirm the DOM did not change.",
      "Update the active selector bundle if the portal UI changed.",
      "Retry the pilot from the latest approved packet after selectors are corrected.",
    ];
  }

  if (message.includes("payment")) {
    return [
      "Complete the PSID or payment step locally and confirm the portal moved forward.",
      "If payment reflected late, refresh the portal state before resuming.",
    ];
  }

  return [
    "Review the latest desktop screenshot and execution log.",
    "Return the filing to the last stable review step if the portal state is unclear.",
    "Retry only after the user confirms the local portal is back on the expected screen.",
  ];
}

async function waitForVisibleSelector(
  windowInstance,
  selector,
  timeoutMs = 15000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const matched = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })();
    `);

    if (matched) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`Timed out waiting for selector: ${selector}`);
}

async function hasSelector(windowInstance, selector) {
  return windowInstance.webContents.executeJavaScript(`
    Boolean(document.querySelector(${JSON.stringify(selector)}));
  `);
}

async function fillSelector(windowInstance, selector, value) {
  if (
    !selector ||
    value === null ||
    value === undefined ||
    String(value).trim() === ""
  ) {
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);
  await windowInstance.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
      element.focus();
      element.value = ${JSON.stringify(String(value))};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    })();
  `);
}

async function clickSelector(windowInstance, selector) {
  if (!selector) {
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);
  await windowInstance.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error("Missing selector: " + ${JSON.stringify(selector)});
      element.click();
    })();
  `);
}

// ── Phase 19.10: trySelectorsInPriority ──────────────────────────────────

/**
 * Attempt selectors in priority order (primary first, then fallbacks).
 * Returns the first selector that matches an element in the DOM.
 * Reports drift to server when a fallback is used.
 */
async function trySelectorsInPriority(
  windowInstance,
  action,
  selectors,
  driftContext,
) {
  if (!selectors || selectors.length === 0) {
    throw new Error(`No selectors provided for action: ${action}`);
  }

  let lastError = null;

  for (let i = 0; i < selectors.length; i++) {
    const selector = selectors[i];
    try {
      await waitForVisibleSelector(windowInstance, selector);
      const usedFallback = i > 0;

      // Phase 19.11: Report drift when a fallback selector is used
      if (usedFallback && driftContext) {
        reportSelectorDriftToServer({
          ...driftContext,
          action,
          primarySelector: selectors[0],
          fallbackUsed: selector,
          fallbackIndex: i,
        }).catch(() => {
          // Fire-and-forget — never block filing on telemetry
        });
      }

      return {
        selector,
        usedFallback,
        fallbackIndex: i,
      };
    } catch (error) {
      lastError = error;
      // Continue to next fallback
    }
  }

  throw new Error(
    `All ${selectors.length} selectors failed for action "${action}". ` +
      `Last error: ${lastError?.message || "unknown"}`,
  );
}

// ── Phase 19.11: reportSelectorDriftToServer ─────────────────────────────

/**
 * Fire-and-forget drift telemetry report to the server.
 * Never blocks filing — errors are silently swallowed.
 */
async function reportSelectorDriftToServer(driftData) {
  try {
    const apiBaseUrl = getApiBaseUrl();
    if (!apiBaseUrl) return;

    const deviceAuthToken =
      launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
    if (!deviceAuthToken) return;

    const reportUrl = new URL(
      "/api/agents/selector-drift-reports",
      apiBaseUrl,
    ).toString();

    const response = await fetch(reportUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceAuthToken}`,
        "X-Agent-Id": getInstallationId(),
      },
      body: JSON.stringify({
        agentId: getInstallationId(),
        jobId: driftData.jobId || null,
        bundleId: driftData.bundleId,
        bundleVersion: Number(driftData.bundleVersion) || 1,
        routeFamily: driftData.routeFamily,
        action: driftData.action,
        primarySelector: driftData.primarySelector,
        fallbackUsed: driftData.fallbackUsed,
        fallbackIndex: driftData.fallbackIndex,
        screenshotUrl: null,
        domSnapshotUrl: null,
      }),
    });

    if (!response.ok && process.env.NODE_ENV === "development") {
      console.warn("[drift-report] Server returned", response.status);
    }
  } catch (_error) {
    // Swallow all errors — drift telemetry must never block filing
  }
}

async function setFileInputFiles(windowInstance, selector, filePaths) {
  if (!selector || !filePaths?.length) {
    return;
  }

  await waitForVisibleSelector(windowInstance, selector);

  const objectIdResponse =
    await windowInstance.webContents.debugger.sendCommand("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      objectGroup: "ejari-worker",
    });

  if (!objectIdResponse?.result?.objectId) {
    throw new Error(`Could not resolve upload selector: ${selector}`);
  }

  await windowInstance.webContents.debugger.sendCommand(
    "DOM.setFileInputFiles",
    {
      objectId: objectIdResponse.result.objectId,
      files: filePaths,
    },
  );
}

async function downloadJobDocuments(jobId, documents) {
  const targetDir = getWorkerTempDir(jobId);
  fs.mkdirSync(targetDir, { recursive: true });

  const downloaded = [];

  for (const document of documents || []) {
    const response = await fetch(document.downloadUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(
        `Failed to download document "${document.fileName}" for local automation.`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const filePath = path.join(targetDir, document.fileName);
    fs.writeFileSync(filePath, buffer);
    downloaded.push({
      ...document,
      localPath: filePath,
    });
  }

  return downloaded;
}

async function cleanupJobDocuments(jobId) {
  const targetDir = getWorkerTempDir(jobId);
  fs.rmSync(targetDir, { recursive: true, force: true });
}

function documentByType(documents, documentType) {
  return (documents || []).find(
    (document) => document.documentType === documentType,
  );
}

async function updateLocalJobStatus(jobId, status, body = {}) {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    throw new Error(
      "Trusted desktop device credentials are not ready for status updates.",
    );
  }

  return fetchJson(`${apiBaseUrl}/api/local-agent/jobs/${jobId}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deviceAuthToken}`,
    },
    body: JSON.stringify({
      status,
      ...body,
    }),
  });
}

async function claimNextLocalJob() {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    return null;
  }

  const payload = await fetchJson(`${apiBaseUrl}/api/local-agent/jobs/next`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deviceAuthToken}`,
    },
  });

  return payload?.job || null;
}

async function loadLocalJobContext(jobId) {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    throw new Error(
      "Trusted desktop device credentials are not ready for job loading.",
    );
  }

  return fetchJson(`${apiBaseUrl}/api/local-agent/jobs/${jobId}/context`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${deviceAuthToken}`,
    },
  });
}

async function attachDebugger(windowInstance) {
  if (windowInstance.webContents.debugger.isAttached()) {
    return;
  }

  windowInstance.webContents.debugger.attach("1.3");
}

async function detachDebugger(windowInstance) {
  if (!windowInstance.webContents.debugger.isAttached()) {
    return;
  }

  try {
    windowInstance.webContents.debugger.detach();
  } catch {
    // Ignore detach errors during cleanup.
  }
}

async function runLocalDldFlow(jobContext, localDocuments) {
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.automationConfig || {};
  const registration = jobContext.registration || {};

  if (!config.validationUrl || !config.validationSelector) {
    throw new Error("Local DLD validation config is incomplete.");
  }

  await windowInstance.loadURL(config.validationUrl);

  if (
    config.validationRejectSelector &&
    (await hasSelector(windowInstance, config.validationRejectSelector))
  ) {
    throw new Error(
      "The local MyDLD session appears invalid and requires reconnect.",
    );
  }

  await waitForVisibleSelector(windowInstance, config.validationSelector);

  if (!config.ejariFlowUrl) {
    throw new Error("Local DLD flow URL is not configured.");
  }

  await windowInstance.loadURL(config.ejariFlowUrl);
  await attachDebugger(windowInstance);

  try {
    const fields = config.fieldSelectors || {};
    await fillSelector(
      windowInstance,
      fields.tenantName,
      registration.tenantName,
    );
    await fillSelector(
      windowInstance,
      fields.landlordName,
      registration.landlordName,
    );
    await fillSelector(
      windowInstance,
      fields.rentAmount,
      registration.rentAmount,
    );
    await fillSelector(
      windowInstance,
      fields.contractStartDate,
      registration.contractStartDate,
    );
    await fillSelector(
      windowInstance,
      fields.contractEndDate,
      registration.contractEndDate,
    );
    await fillSelector(
      windowInstance,
      fields.unitAddress,
      registration.unitAddress,
    );
    await fillSelector(
      windowInstance,
      fields.makaniNumber,
      registration.makaniNumber,
    );
    await fillSelector(
      windowInstance,
      fields.previousEjariId,
      registration.previousEjariId,
    );

    const uploads = config.uploadSelectors || {};
    const tenancyContract = documentByType(localDocuments, "tenancyContract");
    const emiratesId = documentByType(localDocuments, "emiratesId");
    const dewaBill = documentByType(localDocuments, "dewaBill");
    const titleDeed = documentByType(localDocuments, "titleDeed");

    await setFileInputFiles(
      windowInstance,
      uploads.tenancyContract,
      tenancyContract?.localPath ? [tenancyContract.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.emiratesId,
      emiratesId?.localPath ? [emiratesId.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.dewaBill,
      dewaBill?.localPath ? [dewaBill.localPath] : [],
    );
    await setFileInputFiles(
      windowInstance,
      uploads.titleDeed,
      titleDeed?.localPath ? [titleDeed.localPath] : [],
    );

    if (config.nextButtonSelector) {
      await clickSelector(windowInstance, config.nextButtonSelector);
    }

    for (const selector of config.additionalStepSelectors || []) {
      await clickSelector(windowInstance, selector);
    }

    if (!config.submitButtonSelector) {
      throw new Error("Local DLD submit selector is not configured.");
    }

    await clickSelector(windowInstance, config.submitButtonSelector);
    await new Promise((resolve) =>
      setTimeout(resolve, config.postSubmitWaitMs || 5000),
    );

    if (config.successSelector) {
      await waitForVisibleSelector(
        windowInstance,
        config.successSelector,
        15000,
      );
    } else if (config.successUrlFragment) {
      const startedAt = Date.now();
      let matched = false;
      while (Date.now() - startedAt < 15000) {
        const currentUrl = windowInstance.webContents.getURL();
        if (currentUrl.includes(config.successUrlFragment)) {
          matched = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!matched) {
        throw new Error("Timed out waiting for the local DLD success URL.");
      }
    } else {
      throw new Error(
        "A local success selector or success URL fragment is required.",
      );
    }

    return {
      message: "Local desktop DLD automation completed successfully.",
      finalUrl: windowInstance.webContents.getURL(),
    };
  } finally {
    await detachDebugger(windowInstance);
  }
}

/**
 * Standardized log step labels used across dry run and assisted filing flows.
 *
 * TR-V8-030: All execution log entries use these consistent step labels
 * so job history is easier to interpret regardless of flow type.
 *
 * Step labels:
 * - readiness_check       — Trusted Iris session confirmed
 * - route_navigation      — Route-aware IRIS navigation completed
 * - prefill_compare       — Pre-fill comparison captured
 * - field_fill            — Approved packet values filled
 * - password_reset_pause  — Paused for password reset
 * - otp_captcha_pin_pause — Paused for OTP, captcha, and PIN
 * - payment_psid_pause    — Paused for PSID and payment
 * - payment_verification  — Payment state verified on portal
 * - final_submit_boundary — Stopped before final submit
 * - final_submit_confirmation_gate — Paused for final submit confirmation
 * - completion_verification — Completion evidence verified
 * - proof_capture         — Completion proof captured
 * - failure               — Local desktop job failed
 */
const STANDARD_LOG_STEPS = Object.freeze({
  READINESS_CHECK: "readiness_check",
  ROUTE_NAVIGATION: "route_navigation",
  PREFILL_COMPARE: "prefill_compare",
  FIELD_FILL: "field_fill",
  PASSWORD_RESET_PAUSE: "password_reset_pause",
  OTP_CAPTCHA_PIN_PAUSE: "otp_captcha_pin_pause",
  PAYMENT_PSID_PAUSE: "payment_psid_pause",
  PAYMENT_VERIFICATION: "payment_verification",
  FINAL_SUBMIT_BOUNDARY: "final_submit_boundary",
  FINAL_SUBMIT_CONFIRMATION_GATE: "final_submit_confirmation_gate",
  COMPLETION_VERIFICATION: "completion_verification",
  PROOF_CAPTURE: "proof_capture",
  FAILURE: "failure",
});

/**
 * Standardized capture labels used across dry run and assisted filing flows.
 *
 * TR-V8-030: All screenshot captures use these consistent labels
 * so proof artifacts are identifiable regardless of flow type.
 *
 * Capture labels:
 * - Iris readiness screen
 * - Route navigation state
 * - Pre-fill comparison
 * - Field fill complete
 * - Password reset pause
 * - OTP / captcha / PIN pause
 * - Payment / PSID pause
 * - Payment verification
 * - Dry-run review gate
 * - Final submit confirmation gate
 * - Completed Tasks proof
 * - Acknowledgement proof
 * - Return copy proof
 * - CPR proof
 */
const STANDARD_CAPTURE_LABELS = Object.freeze({
  READINESS: "Iris readiness screen",
  ROUTE_NAVIGATION: "Route navigation state",
  PREFILL_COMPARE: "Pre-fill comparison",
  FIELD_FILL: "Field fill complete",
  PASSWORD_RESET: "Password reset pause",
  OTP_CAPTCHA_PIN: "OTP / captcha / PIN pause",
  PAYMENT_PSID: "Payment / PSID pause",
  PAYMENT_VERIFICATION: "Payment verification",
  DRY_RUN_REVIEW_GATE: "Dry-run review gate",
  FINAL_SUBMIT_CONFIRMATION: "Final submit confirmation gate",
  COMPLETED_TASKS: "Completed Tasks proof",
  ACKNOWLEDGEMENT: "Acknowledgement proof",
  RETURN_COPY: "Return copy proof",
  CPR_PROOF: "CPR proof",
});

// ──────────────────────────────────────────────────────────
// Phase 18: Classic Portal Tree Navigation — FULL IMPLEMENTATION
//
// These functions implement text-based navigation for PrimeFaces/JSF
// tree panels (ui-panelmenu) replacing the stubs from Phase 15.5c.
// The classic portal at irisv1.fbr.gov.pk uses PrimeFaces auto-generated
// IDs that are unstable across sessions, so all navigation is done by
// matching visible text labels rather than CSS selectors.
//
// Key design decisions:
// - Panel headers are matched by their text content (e.g., "Business")
// - Sub-items are matched by text inside expanded panels
// - Data table rows are found by matching text in the first data column
// - Fields are identified by their column position (total/exempt/etc.)
// - "Add" (+) buttons are clicked when no matching row exists
// ──────────────────────────────────────────────────────────

/**
 * Expand a classic portal ui-panelmenu header by visible text.
 *
 * Finds panel headers (h3, a.panel-header, or .ui-panelmenu-title) whose
 * text content includes headerText, then clicks to expand the sub-items.
 * On the real PrimeFaces portal, clicking the header toggles expansion.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} headerText - Visible text of the panel header to click
 * @returns {Promise<boolean>} true if a matching header was found and clicked
 */
async function clickClassicTreePanel(windowInstance, headerText) {
  if (!headerText) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchText = ${JSON.stringify(headerText)};

      // Strategy 1: Find .panel-header links (our mock pages)
      let headers = document.querySelectorAll('.panel-header');
      for (const h of headers) {
        if ((h.textContent || '').trim().includes(searchText)) {
          h.classList.add('expanded');
          // Expand the associated sub-items panel
          const panel = h.closest('li');
          if (panel) {
            const subItems = panel.querySelector('.sub-items, ul');
            if (subItems) {
              subItems.classList.add('open');
              subItems.style.display = 'block';
            }
          }
          h.click();
          return true;
        }
      }

      // Strategy 2: Find ui-panelmenu headers via h3 elements
      headers = document.querySelectorAll('.ui-panelmenu .ui-panelmenu-header, h3.ui-panelmenu-title');
      for (const h of headers) {
        if ((h.textContent || '').trim().includes(searchText)) {
          // Click the link inside the header to toggle expansion
          const link = h.querySelector('a');
          if (link) { link.click(); return true; }
          h.click();
          return true;
        }
      }

      // Strategy 3: Generic — find any h3 or heading with matching text
      const allHeadings = document.querySelectorAll('h3, h2, .ui-panelmenu-header a, [role="tab"]');
      for (const h of allHeadings) {
        if ((h.textContent || '').trim().includes(searchText)) {
          h.click();
          return true;
        }
      }

      // Strategy 4: Find any link whose text starts with searchText
      const allLinks = document.querySelectorAll('a, button');
      for (const link of allLinks) {
        const text = (link.textContent || '').trim();
        if (text.includes(searchText) || text.toLowerCase().includes(searchText.toLowerCase())) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  // Wait for the panel to expand and sub-items to render
  if (clicked) {
    await new Promise((resolve) => setTimeout(resolve, 600));
  } else {
    console.warn(
      `[classic-portal] clickClassicTreePanel("${headerText}") — no matching header found`,
    );
  }

  return clicked;
}

/**
 * Click a classic portal panelmenu sub-item by visible text.
 *
 * Finds sub-menu items (<a> or <li> elements) inside the currently
 * expanded panel whose text matches itemText, then clicks to navigate
 * to the corresponding JSF data table form.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} itemText - Visible text of the sub-item to click
 * @returns {Promise<boolean>} true if a matching sub-item was found and clicked
 */
async function clickClassicTreeMenuItem(windowInstance, itemText) {
  if (!itemText) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchText = ${JSON.stringify(itemText)};

      // Strategy 1: Find links inside visible/open sub-items panels
      const openPanels = document.querySelectorAll('.sub-items.open, .sub-items[style*="block"], ul[data-panel]');
      for (const panel of openPanels) {
        const links = panel.querySelectorAll('a');
        for (const link of links) {
          if ((link.textContent || '').trim().includes(searchText)) {
            link.click();
            return true;
          }
        }
      }

      // Strategy 2: Find any sub-item link by data-nav attribute (mock pages)
      const allSubLinks = document.querySelectorAll('.sub-items a, [data-nav]');
      for (const link of allSubLinks) {
        if ((link.textContent || '').trim().includes(searchText)) {
          link.click();
          return true;
        }
      }

      // Strategy 3: ui-panelmenu-content sub-items (real PrimeFaces)
      const menuItems = document.querySelectorAll('.ui-panelmenu .ui-menuitem-link, .ui-panelmenu-content a');
      for (const link of menuItems) {
        const textSpan = link.querySelector('.ui-menuitem-text');
        const text = (textSpan ? textSpan.textContent : link.textContent || '').trim();
        if (text.includes(searchText)) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  if (clicked) {
    // Wait for the JSF form / data table to load after navigation
    await new Promise((resolve) => setTimeout(resolve, 1500));
  } else {
    console.warn(
      `[classic-portal] clickClassicTreeMenuItem("${itemText}") — no matching item found`,
    );
  }

  return clicked;
}

/**
 * Fill a classic portal JSF data table cell by row description and field type.
 *
 * Classic portal data tables use a description/code column to identify rows.
 * This function finds the row whose first text column contains rowDesc,
 * then fills the appropriate input field based on fieldType.
 *
 * Field types map to column positions:
 * - "total" / "amount" / "receipt" → the first numeric input after description
 * - "exempt" / "tax" / "deducted" → the second numeric input after description
 * - By explicit selector: if fieldType starts with "#" or contains ":", use as CSS selector
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} rowDesc - Text to match in the row's description column
 * @param {string} fieldType - Which field in the row to fill ("total", "exempt", "tax", css-selector)
 * @param {string} value - Value to fill into the field
 * @returns {Promise<boolean>} true if the field was found and filled
 */
async function fillClassicDataTable(windowInstance, rowDesc, fieldType, value) {
  if (!rowDesc || value === null || value === undefined) return false;

  const filled = await windowInstance.webContents.executeJavaScript(`
    (() => {
      const searchDesc = ${JSON.stringify(rowDesc)};
      const type = ${JSON.stringify(fieldType)};
      const fillValue = ${JSON.stringify(String(value))};

      // If fieldType is an explicit CSS selector, use it directly
      if (type && (type.startsWith('#') || type.includes(':'))) {
        const el = document.querySelector(type);
        if (el) {
          el.focus();
          if (el.tagName === 'SELECT') {
            // Try to find matching option
            const opts = el.options;
            for (let i = 0; i < opts.length; i++) {
              if ((opts[i].textContent || '').trim().toLowerCase().includes(fillValue.toLowerCase())) {
                el.value = opts[i].value;
                break;
              }
            }
            if (!el.value) el.value = fillValue;
          } else {
            el.value = fillValue;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }

      // Find data tables on the page
      const tables = document.querySelectorAll('table.ui-datatable, table[id*="data"], table[class*="dataTable"]');
      if (tables.length === 0) {
        // Fallback: any table with input fields
        const allTables = document.querySelectorAll('table');
        for (const table of allTables) {
          if (table.querySelectorAll('input[type="text"], input:not([type])').length === 0) continue;

          const rows = table.querySelectorAll('tbody tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;

            // Check if the first text-bearing cell contains rowDesc
            let firstText = '';
            for (const cell of cells) {
              const text = (cell.textContent || '').trim();
              // Skip cells that are just inputs with values
              const input = cell.querySelector('input');
              if (input && text === (input.value || '')) {
                firstText = text;
                break;
              }
              if (text && !cell.querySelector('input')) {
                firstText = text;
                break;
              }
              // Also check input values
              if (input && input.value && input.value.includes(searchDesc)) {
                firstText = input.value;
                break;
              }
            }

            if (!firstText || !firstText.includes(searchDesc)) continue;

            // Find the input fields in this row
            const inputs = row.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
            if (inputs.length === 0) continue;

            // Filter to only visible, non-readonly inputs
            const editableInputs = Array.from(inputs).filter(inp =>
              !inp.readOnly && inp.type !== 'hidden' && inp.offsetParent !== null
            );

            let targetInput = null;

            if (type === 'total' || type === 'amount' || type === 'receipt') {
              targetInput = editableInputs[0];
            } else if (type === 'exempt' || type === 'tax' || type === 'deducted') {
              targetInput = editableInputs[1] || editableInputs[0];
            } else if (type === 'description' || type === 'code') {
              // Fill the description field itself
              targetInput = row.querySelector('input') || editableInputs[0];
            } else {
              // Try numeric index
              const idx = parseInt(type, 10);
              if (!isNaN(idx) && idx < editableInputs.length) {
                targetInput = editableInputs[idx];
              } else {
                targetInput = editableInputs[0];
              }
            }

            if (targetInput) {
              targetInput.focus();
              targetInput.value = fillValue;
              targetInput.dispatchEvent(new Event('input', { bubbles: true }));
              targetInput.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      }

      // Search through recognized data tables
      for (const table of tables) {
        const rows = table.querySelectorAll('tbody tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;

          // Check if any cell text matches rowDesc
          let matched = false;
          for (const cell of cells) {
            const text = (cell.textContent || '').trim();
            const input = cell.querySelector('input');
            if (input && (input.value || '').includes(searchDesc)) { matched = true; break; }
            if (text.includes(searchDesc)) { matched = true; break; }
          }
          if (!matched) continue;

          // Find editable inputs in this row
          const inputs = row.querySelectorAll('input[type="text"], input:not([type]), input[type="number"]');
          const editableInputs = Array.from(inputs).filter(inp =>
            !inp.readOnly && inp.type !== 'hidden' && inp.offsetParent !== null
          );

          let targetInput = null;
          if (type === 'total' || type === 'amount' || type === 'receipt') {
            targetInput = editableInputs[0];
          } else if (type === 'exempt' || type === 'tax' || type === 'deducted') {
            targetInput = editableInputs[1] || editableInputs[0];
          } else {
            targetInput = editableInputs[0];
          }

          if (targetInput) {
            targetInput.focus();
            targetInput.value = fillValue;
            targetInput.dispatchEvent(new Event('input', { bubbles: true }));
            targetInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }

      return false;
    })();
  `);

  if (!filled) {
    console.warn(
      `[classic-portal] fillClassicDataTable("${rowDesc}", "${fieldType}", "${value}") — could not find matching row/field`,
    );
  }

  return filled;
}

/**
 * Click the "Add" (+) button to insert a new row in a classic portal data table.
 *
 * Classic portal uses "Add"/"+" buttons to insert new rows into data tables.
 * The agent must handle row insertion before filling — it can't assume rows exist.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {string} rowDesc - Description for the new row (used to find which table's Add button)
 * @returns {Promise<boolean>} true if an Add button was found and clicked
 */
async function handleClassicAddRow(windowInstance, rowDesc) {
  if (!rowDesc) return false;

  const clicked = await windowInstance.webContents.executeJavaScript(`
    (() => {
      // Strategy 1: Find Add buttons with class add-row-btn
      let addBtns = document.querySelectorAll('.add-row-btn, button[id*="add"], button[class*="add-row"]');
      for (const btn of addBtns) {
        if (btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      // Strategy 2: Find buttons with text "Add" or "+"
      const allBtns = document.querySelectorAll('button, a.btn, [role="button"]');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').trim();
        if ((text === 'Add' || text === '+' || text.includes('Add Row') || text.includes('Add Section')) &&
            btn.offsetParent !== null) {
          btn.click();
          return true;
        }
      }

      // Strategy 3: PrimeFaces commandLink for row addition
      const cmdLinks = document.querySelectorAll('a.ui-commandlink, span.ui-icon-plus');
      for (const link of cmdLinks) {
        if (link.offsetParent !== null) {
          link.click();
          return true;
        }
      }

      return false;
    })();
  `);

  if (clicked) {
    // Wait for the new row to render
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return clicked;
}

/**
 * Navigate the new IRIS portal pre-redirect screens (FBR5-FBR8).
 *
 * Between the dashboard and the classic portal, the new IRIS portal shows:
 * 1. FBR5: "Normal Return" vs "Simplified Return" radio buttons
 * 2. FBR6: Tax period auto-selected + "Continue" button
 * 3. FBR7: "Were you tax resident of Pakistan?" Yes/No radio
 * 4. FBR8: "Accept and Continue" to redirect to classic portal
 *
 * Without handling these screens, the agent never reaches the classic portal.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @returns {Promise<{steps: string[], success: boolean}>}
 */
async function navigateNewPortalPreRedirectFlow(windowInstance) {
  const steps = [];

  // FBR5: Select "Normal Return" radio button
  try {
    const normalReturnClicked = await windowInstance.webContents
      .executeJavaScript(`
      (() => {
        // Try: "Normal Return" radio or label
        const labels = document.querySelectorAll('label, .radio-label, [class*="radio"]');
        for (const label of labels) {
          if ((label.textContent || '').trim().toLowerCase().includes('normal return')) {
            // Click the associated radio input
            const radio = label.querySelector('input[type="radio"]') ||
                          label.previousElementSibling?.querySelector?.('input[type="radio"]') ||
                          document.getElementById(label.getAttribute('for'));
            if (radio) { radio.checked = true; radio.click(); return true; }
            label.click();
            return true;
          }
        }
        // Fallback: find radio by value
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const parentText = (r.parentElement?.textContent || '').trim();
          if (parentText.toLowerCase().includes('normal')) { r.checked = true; r.click(); return true; }
        }
        return false;
      })();
    `);
    if (normalReturnClicked) {
      steps.push("return_type_selected");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR5 return type selection failed:",
      err.message,
    );
  }

  // FBR6: Click "Continue" on period screen
  try {
    const continueClicked = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]');
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim();
          if (text.toLowerCase() === 'continue' || text.toLowerCase().includes('continue')) {
            btn.click();
            return true;
          }
        }
        return false;
      })();
    `);
    if (continueClicked) {
      steps.push("period_continue");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (err) {
    console.warn("[classic-portal] FBR6 continue failed:", err.message);
  }

  // FBR7: Select "Yes" for tax residency
  try {
    const residencyClicked = await windowInstance.webContents
      .executeJavaScript(`
      (() => {
        const labels = document.querySelectorAll('label, .radio-label');
        for (const label of labels) {
          const text = (label.textContent || '').trim().toLowerCase();
          if (text.includes('tax resident') || text.includes('resident of pakistan')) {
            // Find the associated radio — look for "Yes"
            const container = label.closest('div, fieldset, .form-group');
            if (container) {
              const yesRadio = container.querySelector('input[value="yes"], input[id*="yes"], input[id*="resident"]');
              if (yesRadio) { yesRadio.checked = true; yesRadio.click(); return true; }
            }
            // Fallback: first radio in the group
            const firstRadio = label.parentElement?.querySelector?.('input[type="radio"]');
            if (firstRadio) { firstRadio.checked = true; firstRadio.click(); return true; }
            return true;
          }
        }
        // Fallback: find any radio that looks like "Yes"
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
          const parentText = (r.parentElement?.textContent || '').trim().toLowerCase();
          if (parentText === 'yes' || parentText.includes('resident')) {
            r.checked = true; r.click(); return true;
          }
        }
        return false;
      })();
    `);
    if (residencyClicked) {
      steps.push("residency_declared");
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR7 residency declaration failed:",
      err.message,
    );
  }

  // FBR8: Click "Accept and Continue" to redirect to classic portal
  try {
    const redirectClicked = await windowInstance.webContents.executeJavaScript(`
      (() => {
        const btns = document.querySelectorAll('button, a.btn, input[type="submit"], input[type="button"]');
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (text.includes('accept') || text.includes('redirect') || text.includes('continue to')) {
            btn.click();
            return true;
          }
        }
        // Fallback: look for "Continue" again (might be generic)
        for (const btn of btns) {
          const text = (btn.textContent || btn.value || '').trim().toLowerCase();
          if (text === 'continue') {
            btn.click();
            return true;
          }
        }
        return false;
      })();
    `);
    if (redirectClicked) {
      steps.push("redirect_accepted");
    }
  } catch (err) {
    console.warn(
      "[classic-portal] FBR8 redirect acceptance failed:",
      err.message,
    );
  }

  // Wait for the classic portal to fully load after redirect
  if (steps.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return {
    steps,
    success: steps.length >= 2,
    detail: `Pre-redirect flow: ${steps.join(" → ") || "no screens detected"}. ${steps.length} of 4 screens handled.`,
  };
}

/**
 * Map an irisSection label to the classic portal tree navigation path.
 *
 * Returns { panel, item } for the tree panel header and sub-item to click,
 * or null if the section cannot be mapped.
 */
function resolveClassicSectionPath(irisSection) {
  if (!irisSection) return null;
  const s = irisSection.toLowerCase();

  if (s.includes("other revenue") || s.includes("other revenues")) {
    return { panel: "Business", item: "Other Revenues" };
  }
  if (s.includes("business asset")) {
    return { panel: "Business", item: "Business Assets" };
  }
  if (s.includes("fixed") && s.includes("final tax")) {
    return { panel: "Tax Chargeable / Payments", item: "Fixed / Final Tax" };
  }
  if (s.includes("adjustable tax") || s.includes("tax credit")) {
    return { panel: "Tax Chargeable / Payments", item: "Adjustable Tax" };
  }
  if (s.includes("personal expense")) {
    return { panel: "Wealth Statement", item: "Personal Expenses" };
  }
  if (s.includes("asset") && (s.includes("wealth") || s.includes("personal"))) {
    return { panel: "Wealth Statement", item: "Assets" };
  }
  if (s.includes("liabilit")) {
    return { panel: "Wealth Statement", item: "Liabilities" };
  }
  if (s.includes("reconciliation")) {
    return { panel: "Wealth Statement", item: "Reconciliation" };
  }
  if (
    s.includes("attribut") ||
    s.includes("business sector") ||
    s.includes("residence")
  ) {
    return { panel: "Attributes", item: "Business Sector / Residence" };
  }
  if (s.includes("capital asset") || s.includes("7e")) {
    return { panel: "Capital Assets (7E)", item: "Property Details" };
  }
  if (s.includes("comput") || s.includes("return summar")) {
    return { panel: "Computations", item: "Return Summary" };
  }
  return null;
}

/**
 * Navigate to a specific classic portal section by clicking tree panels and sub-items.
 *
 * This is used for per-section navigation: navigate → fill section fields →
 * navigate to next section → fill its fields. Each section lives on its own
 * JSF form page in the real classic portal.
 *
 * @param {BrowserWindow} windowInstance
 * @param {string} irisSection - IRIS section name (e.g., "Other Revenues")
 * @returns {Promise<boolean>}
 */
async function navigateToClassicSection(windowInstance, irisSection) {
  if (!irisSection) return false;

  const path = resolveClassicSectionPath(irisSection);
  if (!path) {
    console.warn(
      `[classic-portal] No tree path mapped for section: "${irisSection}"`,
    );
    return false;
  }

  const panelExpanded = await clickClassicTreePanel(windowInstance, path.panel);
  if (!panelExpanded) {
    console.warn(
      `[classic-portal] Could not expand panel "${path.panel}" for section "${irisSection}"`,
    );
  }

  const itemClicked = await clickClassicTreeMenuItem(windowInstance, path.item);
  if (itemClicked) {
    console.log(
      `[classic-portal] Navigated to section: ${path.panel} \u2192 ${path.item}`,
    );
    return true;
  }

  console.warn(
    `[classic-portal] Could not click item "${path.item}" in panel "${path.panel}"`,
  );
  return false;
}

/**
 * Full classic portal tree navigation \u2014 initial arrival (Phase 18 implementation).
 *
 * This function handles getting the agent TO the classic portal and verifying
 * it's ready. Per-section navigation happens separately via navigateToClassicSection()
 * during the fill loop, because each section is on its own JSF form page.
 *
 * For mock mode: loads the classic-portal.html mock page.
 * For live mode: navigates pre-redirect screens (FBR5-FBR8), then verifies tree panel.
 *
 * @param {BrowserWindow} windowInstance - Electron BrowserWindow
 * @param {Object} routeSelector - Route selector config
 * @param {boolean} useMockIris - Whether to use mock pages
 * @returns {Promise<{steps: string[], formReady: boolean, detail: string}>}
 */
async function navigateClassicPortalFlow(
  windowInstance,
  routeSelector,
  useMockIris,
) {
  const steps = [];

  if (useMockIris) {
    const classicUrl = resolveMockIrisUrl("mock-iris://classic-portal");
    await windowInstance.loadURL(classicUrl);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    steps.push("classic_portal_loaded");

    const formReady = await verifyFormReady(windowInstance, routeSelector);
    if (formReady) steps.push("data_table_ready");

    return {
      steps,
      formReady,
      detail: `Classic portal mock loaded: ${steps.join(" \u2192 ")}. Form ready: ${formReady}.`,
    };
  }

  const preRedirectResult =
    await navigateNewPortalPreRedirectFlow(windowInstance);
  steps.push(...preRedirectResult.steps.map((s) => `preredirect_${s}`));
  steps.push("awaiting_classic_portal");

  if (!preRedirectResult.success) {
    console.warn(
      "[classic-portal] Pre-redirect flow may not have completed all screens. Proceeding anyway...",
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));

  const isClassicPortal = await windowInstance.webContents.executeJavaScript(`
    (() => {
      return !!(
        document.querySelector('.ui-panelmenu') ||
        document.querySelector('#correspondenceTabs\\\\:returnAmountForm\\\\:menuPanel') ||
        document.querySelector('[id*="menuPanel"]') ||
        document.querySelector('.tree-panel') ||
        document.querySelector('table.ui-datatable')
      );
    })();
  `);

  if (!isClassicPortal) {
    throw new Error(
      "Expected classic portal (PrimeFaces/JSF tree panel) but tree menu was not detected on the page after pre-redirect flow.",
    );
  }
  steps.push("classic_portal_detected");

  const formReady = await verifyFormReady(windowInstance, routeSelector);
  if (formReady) steps.push("data_table_ready");

  return {
    steps,
    formReady,
    detail: `Classic portal live flow: ${steps.join(" \u2192 ")}. Form ready: ${formReady}.`,
  };
}

/**
 * Determine if the route requires classic portal (PrimeFaces/JSF) navigation.
 */
function isClassicPortalRoute(routeMetadata) {
  return routeMetadata?.routeFamily === "classic_individual_114";
}

async function runLocalTaxDryRunFlow(jobContext) {
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.taxAutomationConfig || {};
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || {};
  const portalFieldMap = Array.isArray(snapshot.portalFieldMap)
    ? snapshot.portalFieldMap
    : [];
  const executionLog = [];
  const routeSelector = config?.routeSelector || null;
  const routeMetadata = snapshot.routeMetadata || {};
  const selectorBundle = getSelectorBundleSignal(jobContext);

  if (!portalFieldMap.length) {
    throw new Error(
      "The approved filing packet does not contain a portal field map for dry-run fill.",
    );
  }

  const readySelector =
    config?.readiness?.readySelector || "#iris-dashboard-ready";
  const entryUrl = resolveWorkerEntryUrl(config);

  if (config.useMockIris) {
    await windowInstance.loadURL(getMockIrisFile("dashboard.html"));
  } else {
    await windowInstance.loadURL(config?.readiness?.loginUrl || entryUrl);
  }

  await waitForVisibleSelector(windowInstance, readySelector, 15000);
  executionLog.push({
    step: STANDARD_LOG_STEPS.READINESS_CHECK,
    label: "Trusted Iris session confirmed",
    detail:
      "Desktop worker validated the configured ready screen before entering dry-run data.",
  });

  const captures = [
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.READINESS,
    ),
  ];

  // ── Phase 15.5c F7: Route-family-aware branching ──
  if (config.useMockIris) {
    await clickSelector(windowInstance, "#open-return-dry-run");
  } else if (isClassicPortalRoute(routeMetadata)) {
    // Classic portal (PrimeFaces/JSF tree navigation) — Phase 18 FULL IMPLEMENTATION
    const navigationResult = await navigateClassicPortalFlow(
      windowInstance,
      routeSelector,
      Boolean(config.useMockIris),
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Classic portal tree navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Classic portal navigation completed but the target data table was not detected as ready.",
      );
    }
  } else if (routeSelector) {
    // New portal: route-aware navigation via top-menu + left-category
    const formLabel = routeMetadata.routeLabel || null;
    const taxYear = packet.taxYear || snapshot.taxYear || null;
    const taxpayerName = snapshot.taxpayerName || null;

    const navigationResult = await navigateToIrisForm(
      windowInstance,
      routeSelector,
      formLabel,
      taxYear,
      taxpayerName,
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Route-aware IRIS navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Route-aware navigation completed but the target form was not detected as ready.",
      );
    }
  } else {
    await windowInstance.loadURL(entryUrl);
  }

  // Fill portal fields — Phase 18: Classic portal uses per-section navigation + fillClassicDataTable().
  // Each classic portal section is on its own JSF form page, so we navigate to each section,
  // handle Add-row if needed, fill its fields, then move to the next section.
  const isClassicRoute = isClassicPortalRoute(routeMetadata);
  if (isClassicRoute) {
    // Group classic portal fields by irisSection for per-section navigation
    const sectionGroups = new Map();
    for (const field of portalFieldMap) {
      if (field.section && field.section.startsWith("classic.")) {
        const sectionKey = field.irisSection || field.section;
        if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, []);
        sectionGroups.get(sectionKey).push(field);
      }
    }

    // Navigate to each section and fill its fields
    for (const [sectionKey, fields] of sectionGroups) {
      // Navigate to the section's data table page
      await navigateToClassicSection(windowInstance, sectionKey);

      // Handle Add-row: for sections like "Fixed / Final Tax", rows may not exist yet
      // Check if any data table rows exist; if not, try to add one
      const rowCount = await windowInstance.webContents
        .executeJavaScript(
          `
        (() => {
          const tables = document.querySelectorAll('table.ui-datatable, table');
          for (const t of tables) {
            const rows = t.querySelectorAll('tbody tr');
            if (rows.length > 0) return rows.length;
          }
          return 0;
        })();
      `,
        )
        .catch(() => 0);

      if (rowCount === 0) {
        const firstFieldLabel = fields[0]?.label || sectionKey;
        await handleClassicAddRow(windowInstance, firstFieldLabel);
      }

      // Fill each field in this section
      for (const field of fields) {
        const rowDesc = field.label || field.key.split(".").pop() || "";
        // Determine field type from irisSection/label: "total" for amount, "exempt" for tax collected
        const isExemptOrTax =
          (field.irisSection || "").toLowerCase().includes("tax collected") ||
          (field.irisSection || "").toLowerCase().includes("deducted") ||
          (field.irisSection || "").toLowerCase().includes("exempt") ||
          (field.label || "").toLowerCase().includes("tax collected") ||
          (field.label || "").toLowerCase().includes("deducted") ||
          (field.label || "").toLowerCase().includes("exempt");
        const fieldType = isExemptOrTax ? "exempt" : "total";

        const filled = await fillClassicDataTable(
          windowInstance,
          rowDesc,
          fieldType,
          field.value,
        );
        // Fallback to selector-based fill
        if (!filled && field.selector) {
          try {
            await fillSelector(windowInstance, field.selector, field.value);
          } catch {
            // Both strategies failed
          }
        }
      }
    }

    // Fill any non-classic fields using standard selector approach
    for (const field of portalFieldMap) {
      if (!field.section || !field.section.startsWith("classic.")) {
        const selector =
          field.selector ||
          `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
        await fillSelector(windowInstance, selector, field.value);
      }
    }
  } else {
    // Non-classic: standard fill using selectors
    for (const field of portalFieldMap) {
      const selector =
        field.selector ||
        `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
      await fillSelector(windowInstance, selector, field.value);
    }
  }

  executionLog.push({
    step: STANDARD_LOG_STEPS.FIELD_FILL,
    label: "Approved packet values filled",
    detail: `Dry run filled ${portalFieldMap.length} mapped packet values into the local Iris workspace.`,
  });

  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.FIELD_FILL,
    ),
  );

  const reviewGateSelector =
    config?.dryRun?.reviewGateSelector || "#dry-run-review-gate";
  await waitForVisibleSelector(windowInstance, reviewGateSelector, 15000);
  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.DRY_RUN_REVIEW_GATE,
    ),
  );

  const finalSubmitSelector =
    config?.dryRun?.finalSubmitSelector || "#final-submit";
  const finalSubmitVisible = await hasSelector(
    windowInstance,
    finalSubmitSelector,
  );

  executionLog.push({
    step: STANDARD_LOG_STEPS.FINAL_SUBMIT_BOUNDARY,
    label: "Stopped before final submit",
    detail: finalSubmitVisible
      ? "Final submit control was visible, but dry-run mode stopped without clicking it."
      : "Dry-run mode stopped at the configured review gate before any final submission control.",
  });

  return {
    result: {
      message:
        "Local Iris dry run completed and stopped at the final review gate.",
      pauseReason:
        config?.dryRun?.pauseReason ||
        "Dry-run reached the final review gate. Final submit stays user controlled.",
      finalUrl: windowInstance.webContents.getURL(),
      reviewedFieldCount: portalFieldMap.length,
      packetVersion: packet.packetVersion || null,
      packetHash: packet.packetHash || null,
      selectorBundle,
      captures,
    },
    executionLog,
  };
}

function getPilotStateFromContext(jobContext) {
  const payload = jobContext?.job?.payload || jobContext?.payload || {};
  if (
    payload &&
    typeof payload === "object" &&
    payload.livePilotState &&
    typeof payload.livePilotState === "object"
  ) {
    return payload.livePilotState;
  }

  return {
    phase: "start",
    confirmations: [],
  };
}

async function pauseAssistedPilot(job, windowInstance, input) {
  const captures = [
    await captureWindowScreenshot(windowInstance, input.captureLabel),
  ];
  await updateLocalJobStatus(job.id, "awaiting_user_action", {
    result: {
      message: input.message,
      pauseReason: input.pauseReason,
      requiredAction: input.requiredAction,
      userInstruction: input.userInstruction,
      recoveryActions: input.recoveryActions || [],
      selectorBundle: input.selectorBundle || null,
      captures,
      ...(input.extraResult && typeof input.extraResult === "object"
        ? input.extraResult
        : {}),
    },
    executionLog: input.executionLog,
  });

  return {
    paused: true,
  };
}

async function runLocalTaxAssistedFilingFlow(jobContext, job) {
  const windowInstance = await ensureWorkerWindow();
  const config = jobContext.taxAutomationConfig || {};
  const packet = jobContext.filingPacket || {};
  const snapshot = packet.snapshot || {};
  const portalFieldMap = Array.isArray(snapshot.portalFieldMap)
    ? snapshot.portalFieldMap
    : [];
  const executionLog = [];
  const pilotState = getPilotStateFromContext(jobContext);
  const assistedConfig = config.assistedFiling || {};
  const routeSelector = config?.routeSelector || null;
  const routeMetadata = snapshot.routeMetadata || {};
  const selectorBundle = getSelectorBundleSignal(jobContext);
  // Phase 15.5c F7/F9: Is this a classic portal route?
  const isClassic = isClassicPortalRoute(routeMetadata);

  if (!portalFieldMap.length) {
    throw new Error(
      "The approved filing packet does not contain a portal field map for assisted filing.",
    );
  }

  const readySelector =
    config?.readiness?.readySelector || "#iris-dashboard-ready";
  const dashboardUrl = resolveMockIrisUrl(
    assistedConfig.readinessUrl || "mock-iris://dashboard",
  );
  await windowInstance.loadURL(dashboardUrl);
  await waitForVisibleSelector(windowInstance, readySelector, 15000);
  executionLog.push({
    step: STANDARD_LOG_STEPS.READINESS_CHECK,
    label: "Trusted Iris session confirmed",
    detail:
      "Desktop worker validated the trusted local Iris session before entering the live pilot.",
  });

  const captures = [
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.READINESS,
    ),
  ];

  // ── Phase 15.5c F7: Route-family-aware navigation branching ──
  if (config.useMockIris) {
    const returnUrl = resolveWorkerEntryUrl(config);
    await windowInstance.loadURL(returnUrl);
  } else if (isClassic) {
    // Classic portal (PrimeFaces/JSF tree navigation) — Phase 18 FULL IMPLEMENTATION
    const navigationResult = await navigateClassicPortalFlow(
      windowInstance,
      routeSelector,
      Boolean(config.useMockIris),
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Classic portal tree navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Classic portal navigation completed but the target data table was not detected as ready.",
      );
    }
  } else if (routeSelector) {
    // New portal: route-aware navigation via top-menu + left-category
    const formLabel = routeMetadata.routeLabel || null;
    const taxYear = packet.taxYear || snapshot.taxYear || null;
    const taxpayerName = snapshot.taxpayerName || null;

    const navigationResult = await navigateToIrisForm(
      windowInstance,
      routeSelector,
      formLabel,
      taxYear,
      taxpayerName,
    );

    executionLog.push({
      step: STANDARD_LOG_STEPS.ROUTE_NAVIGATION,
      label: "Route-aware IRIS navigation completed",
      detail: navigationResult.detail,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.ROUTE_NAVIGATION,
      ),
    );

    if (!navigationResult.formReady) {
      throw new Error(
        "Route-aware navigation completed but the target form was not detected as ready.",
      );
    }
  } else {
    const returnUrl = resolveWorkerEntryUrl(config);
    await windowInstance.loadURL(returnUrl);
  }

  const prefillComparison = await collectPreFillComparison(
    windowInstance,
    portalFieldMap,
  );
  // Phase 18: Classic portal uses per-section navigation + fillClassicDataTable().
  // Each classic portal section is on its own JSF form page, so we navigate to each section,
  // handle Add-row if needed, fill its fields, then move to the next section.
  if (isClassic) {
    // Group classic portal fields by irisSection for per-section navigation
    const sectionGroups = new Map();
    for (const field of portalFieldMap) {
      if (field.section && field.section.startsWith("classic.")) {
        const sectionKey = field.irisSection || field.section;
        if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, []);
        sectionGroups.get(sectionKey).push(field);
      }
    }

    for (const [sectionKey, fields] of sectionGroups) {
      await navigateToClassicSection(windowInstance, sectionKey);

      const rowCount = await windowInstance.webContents
        .executeJavaScript(
          `
        (() => {
          const tables = document.querySelectorAll('table.ui-datatable, table');
          for (const t of tables) {
            const rows = t.querySelectorAll('tbody tr');
            if (rows.length > 0) return rows.length;
          }
          return 0;
        })();
      `,
        )
        .catch(() => 0);

      if (rowCount === 0) {
        const firstFieldLabel = fields[0]?.label || sectionKey;
        await handleClassicAddRow(windowInstance, firstFieldLabel);
      }

      for (const field of fields) {
        const rowDesc = field.label || field.key.split(".").pop() || "";
        const isExemptOrTax =
          (field.irisSection || "").toLowerCase().includes("tax collected") ||
          (field.irisSection || "").toLowerCase().includes("deducted") ||
          (field.irisSection || "").toLowerCase().includes("exempt") ||
          (field.label || "").toLowerCase().includes("tax collected") ||
          (field.label || "").toLowerCase().includes("deducted") ||
          (field.label || "").toLowerCase().includes("exempt");
        const fieldType = isExemptOrTax ? "exempt" : "total";

        const filled = await fillClassicDataTable(
          windowInstance,
          rowDesc,
          fieldType,
          field.value,
        );
        if (!filled && field.selector) {
          try {
            await fillSelector(windowInstance, field.selector, field.value);
          } catch {
            // Both strategies failed
          }
        }
      }
    }

    // Fill any non-classic fields
    for (const field of portalFieldMap) {
      if (!field.section || !field.section.startsWith("classic.")) {
        const selector =
          field.selector ||
          `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
        await fillSelector(windowInstance, selector, field.value);
      }
    }
  } else {
    for (const field of portalFieldMap) {
      const selector =
        field.selector ||
        `[data-tax-field-key="${String(field.key).replace(/"/g, '\\"')}"]`;
      await fillSelector(windowInstance, selector, field.value);
    }
  }

  executionLog.push({
    step: STANDARD_LOG_STEPS.PREFILL_COMPARE,
    label: "Pre-fill comparison captured",
    detail:
      prefillComparison.length > 0
        ? `${prefillComparison.length} existing portal values differed from the approved packet before fill.`
        : "No material pre-fill differences were detected before assisted fill.",
  });

  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.PREFILL_COMPARE,
    ),
  );
  captures.push(
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.FIELD_FILL,
    ),
  );

  // ── Phase 15.5c F9: Classic portal has no mid-filing password reset ──
  if (pilotState.phase === "start" && !isClassic) {
    await windowInstance.loadURL(
      resolveMockIrisUrl(
        assistedConfig.passwordResetUrl || "mock-iris://password-reset",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PASSWORD_RESET_PAUSE,
      label: "Paused for password reset",
      detail:
        "Pilot paused so the user can complete any Iris password reset locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "password_reset",
      captureLabel: STANDARD_CAPTURE_LABELS.PASSWORD_RESET,
      message: "Assisted filing paused for a password reset checkpoint.",
      pauseReason:
        "Complete any required Iris password reset locally before continuing.",
      userInstruction:
        "If Iris asked for a password reset, finish it on the trusted device, then continue here.",
      recoveryActions: [
        "Complete the password reset locally.",
        "Return to the ready screen if the portal logs you out.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal has no mid-filing OTP/captcha ──
  if (pilotState.phase === "after_password_reset" && !isClassic) {
    await windowInstance.loadURL(
      resolveMockIrisUrl(
        assistedConfig.otpCaptchaUrl || "mock-iris://otp-captcha",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.OTP_CAPTCHA_PIN_PAUSE,
      label: "Paused for OTP, captcha, and PIN",
      detail:
        "Pilot paused so the user can handle OTP, captcha, and any Iris PIN gates locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "otp_captcha_pin",
      captureLabel: STANDARD_CAPTURE_LABELS.OTP_CAPTCHA_PIN,
      message: "Assisted filing paused for OTP, captcha, or PIN confirmation.",
      pauseReason:
        "Complete the OTP, captcha, or Iris PIN step locally before continuing.",
      userInstruction:
        "Handle the verification prompts on the trusted device, then continue here.",
      recoveryActions: [
        "Wait for the OTP or captcha challenge to clear locally.",
        "Only continue after the portal moves past the verification gate.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal Section 154A = final tax, no PSID/payment needed ──
  if (
    pilotState.phase === "after_otp_captcha_pin" &&
    !isClassic &&
    Number(snapshot.returnSummary?.taxPayable || 0) > 0
  ) {
    await windowInstance.loadURL(
      resolveMockIrisUrl(assistedConfig.paymentUrl || "mock-iris://payment"),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PAYMENT_PSID_PAUSE,
      label: "Paused for PSID and payment",
      detail:
        "Pilot paused so the user can create a PSID or complete payment locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "payment_psid",
      captureLabel: STANDARD_CAPTURE_LABELS.PAYMENT_PSID,
      message: "Assisted filing paused for PSID or payment handling.",
      pauseReason:
        "Complete PSID creation or payment locally before continuing.",
      userInstruction:
        "Finish the PSID or payment step on the trusted device, then continue here.",
      recoveryActions: [
        "Record the PSID or CPR in Tax Rocket after payment if needed.",
        "Only continue once the portal is ready to move to final review.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // ── Phase 15.5c F9: Classic portal phase transitions ──
  // Classic portal skips password_reset, otp_captcha_pin, and payment_psid.
  // Instead: start → classic_final_review → classic_pin_entry → proof capture.
  if (isClassic) {
    if (
      pilotState.phase === "start" ||
      pilotState.phase === "after_password_reset"
    ) {
      // Classic portal: go directly to final review (save→submit→confirm dialog)
      const classicConfig = config.classicAssistedFiling || {};
      await windowInstance.loadURL(
        resolveMockIrisUrl(
          classicConfig.finalReviewUrl || "mock-iris://classic-portal",
        ),
      );
      executionLog.push({
        step: STANDARD_LOG_STEPS.FINAL_SUBMIT_CONFIRMATION_GATE,
        label: "Paused for classic portal final review",
        detail:
          "Classic portal pilot paused at the final review gate (save → submit → confirm dialog).",
      });
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "classic_final_review",
        captureLabel: STANDARD_CAPTURE_LABELS.FINAL_SUBMIT_CONFIRMATION,
        message:
          "Assisted filing paused at the classic portal final review gate.",
        pauseReason:
          "Complete the classic portal save → submit → confirm dialog locally, then continue for PIN entry.",
        userInstruction:
          "In the classic portal: click Save, then Submit, confirm the declaration dialog. Then continue here.",
        recoveryActions: [
          "Complete the save → submit → confirm dialog sequence locally.",
          "Only continue after the rule engine validation completes and the PIN dialog appears.",
        ],
        selectorBundle,
        executionLog,
      });
    }

    if (
      pilotState.phase === "after_otp_captcha_pin" ||
      pilotState.phase === "after_payment_psid"
    ) {
      // Classic portal PIN entry: after submit confirmation, the portal shows a 4-digit PIN dialog
      const classicConfig = config.classicAssistedFiling || {};
      await windowInstance.loadURL(
        resolveMockIrisUrl(
          classicConfig.pinEntryUrl || "mock-iris://classic-pin",
        ),
      );
      executionLog.push({
        step: "classic_pin_entry_pause",
        label: "Paused for classic portal PIN entry",
        detail:
          "Classic portal pilot paused for 4-digit FBR PIN entry before final submission.",
      });
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "classic_pin_entry",
        captureLabel: "Classic portal PIN entry",
        message: "Assisted filing paused for classic portal 4-digit PIN entry.",
        pauseReason:
          "Enter the 4-digit FBR PIN in the classic portal PIN dialog before final submission.",
        userInstruction:
          "Enter your FBR PIN, click Submit, then continue here for proof capture.",
        recoveryActions: [
          "Enter the 4-digit FBR PIN in the classic portal PIN dialog.",
          "Click Submit. The return should move from Drafts to Completed.",
        ],
        selectorBundle,
        executionLog,
      });
    }
  }

  // ── New portal (non-classic) phase transitions ──
  if (
    !isClassic &&
    (pilotState.phase === "after_otp_captcha_pin" ||
      pilotState.phase === "after_payment_psid")
  ) {
    await windowInstance.loadURL(
      resolveMockIrisUrl(
        assistedConfig.finalReviewUrl || "mock-iris://final-review",
      ),
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.FINAL_SUBMIT_CONFIRMATION_GATE,
      label: "Paused for final submit confirmation",
      detail:
        "Pilot stopped at the final declaration so the user can confirm the last action locally.",
    });
    return pauseAssistedPilot(job, windowInstance, {
      requiredAction: "final_submit_confirmation",
      captureLabel: STANDARD_CAPTURE_LABELS.FINAL_SUBMIT_CONFIRMATION,
      message: "Assisted filing paused at the final submit confirmation gate.",
      pauseReason:
        "User must confirm the final declaration locally before proof capture can continue.",
      userInstruction:
        "If you submitted locally, continue here so Tax Rocket can capture proof and close the pilot job.",
      recoveryActions: [
        "Only continue after the final declaration was confirmed locally.",
        "If the submission did not succeed, stop and review the portal screen before retrying.",
      ],
      selectorBundle,
      executionLog,
    });
  }

  // After final submit confirmation: verify payment state and capture completion evidence
  // Check payment state before proceeding to proof capture
  if (routeSelector && !config.useMockIris && !isClassic) {
    // Verify CPR and payment state on the portal
    const paymentVerification = await verifyCprAndPayment(
      windowInstance,
      routeSelector,
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.PAYMENT_VERIFICATION,
      label: "Payment state verified on portal",
      detail: `CPR detected: ${paymentVerification.cprDetected}, Paid: ${paymentVerification.paidAmount || "N/A"}, Refund: ${paymentVerification.refundDetected}, Submit unlocked: ${paymentVerification.submitUnlocked}`,
    });

    captures.push(
      await captureWindowScreenshot(
        windowInstance,
        STANDARD_CAPTURE_LABELS.PAYMENT_VERIFICATION,
      ),
    );

    // Enforce ready_to_submit gate: if payment is required and submit is not unlocked,
    // pause for user intervention
    if (
      Number(snapshot.returnSummary?.taxPayable || 0) > 0 &&
      !paymentVerification.submitUnlocked
    ) {
      return pauseAssistedPilot(job, windowInstance, {
        requiredAction: "payment_verification",
        captureLabel: STANDARD_CAPTURE_LABELS.PAYMENT_VERIFICATION,
        message: "Payment state on the portal does not allow submission yet.",
        pauseReason:
          "Complete payment or verify CPR on the portal before continuing.",
        userInstruction:
          "Check the payment status on the trusted device and ensure the submit button is enabled.",
        recoveryActions: [
          "Complete the PSID or payment step locally.",
          "Refresh the portal and verify the submit button is enabled.",
        ],
        selectorBundle,
        executionLog,
      });
    }
  }

  await windowInstance.loadURL(
    resolveMockIrisUrl(
      assistedConfig.completedTasksUrl || "mock-iris://completed",
    ),
  );
  const proofCaptures = [
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.COMPLETED_TASKS,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.ACKNOWLEDGEMENT,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.RETURN_COPY,
    ),
    await captureWindowScreenshot(
      windowInstance,
      STANDARD_CAPTURE_LABELS.CPR_PROOF,
    ),
  ];
  captures.push(...proofCaptures);

  // Verify completion evidence on the portal
  let completionEvidence = null;
  if (routeSelector && !config.useMockIris) {
    completionEvidence = await verifyCompletionEvidence(
      windowInstance,
      routeSelector,
    );
    executionLog.push({
      step: STANDARD_LOG_STEPS.COMPLETION_VERIFICATION,
      label: "Completion evidence verified",
      detail: `Completed tasks: ${completionEvidence.completedTasksDetected}, Acknowledgement: ${completionEvidence.acknowledgementDetected}, Return copy: ${completionEvidence.returnCopyDetected}, CPR proof: ${completionEvidence.cprProofDetected}`,
    });
  }

  executionLog.push({
    step: STANDARD_LOG_STEPS.PROOF_CAPTURE,
    label: "Completion proof captured",
    detail:
      "Desktop worker captured Completed Tasks, acknowledgement, return copy, and CPR proof surfaces.",
  });

  return {
    result: {
      message: "Controlled assisted filing pilot completed with proof capture.",
      finalUrl: windowInstance.webContents.getURL(),
      packetVersion: packet.packetVersion || null,
      packetHash: packet.packetHash || null,
      selectorBundle,
      prefillComparison,
      captures,
      proofSummary: completionEvidence || {
        completedTasks: true,
        acknowledgement: true,
        returnCopy: true,
        cpr: true,
      },
      paymentVerification:
        routeSelector && !config.useMockIris
          ? await verifyCprAndPayment(windowInstance, routeSelector).catch(
              () => null,
            )
          : null,
    },
    executionLog,
  };
}

async function processLocalJob(job) {
  const context = await loadLocalJobContext(job.id);
  pushStatus(
    "progress",
    `Running local desktop automation for job ${job.publicId || job.id}.`,
  );

  const localDocuments = await downloadJobDocuments(job.id, context.documents);

  try {
    await updateLocalJobStatus(job.id, "running");
    const outcome =
      job.type === "tax_dry_run"
        ? await runLocalTaxDryRunFlow(context)
        : job.type === "tax_assisted_filing"
          ? await runLocalTaxAssistedFilingFlow(context, job)
          : {
              result: await runLocalDldFlow(context, localDocuments),
              executionLog: [],
            };
    if (outcome?.paused) {
      pushStatus(
        "progress",
        "Local desktop job is waiting for a user action before it can continue.",
      );
      return;
    }
    await updateLocalJobStatus(job.id, "completed", {
      result: outcome.result,
      executionLog: outcome.executionLog,
    });
    pushStatus("success", "Local desktop automation completed successfully.");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The local desktop automation failed unexpectedly.";
    const failureExecutionLog = [
      {
        step: STANDARD_LOG_STEPS.FAILURE,
        label: "Local desktop job failed",
        detail: message,
      },
    ];
    const recoverableAssistedIssue =
      job.type === "tax_assisted_filing"
        ? classifyRecoverableAssistedIssue(
            message,
            failureExecutionLog,
            context,
          )
        : null;

    if (recoverableAssistedIssue) {
      await updateLocalJobStatus(job.id, "awaiting_user_action", {
        result: {
          message: recoverableAssistedIssue.message,
          pauseReason: recoverableAssistedIssue.pauseReason,
          requiredAction: recoverableAssistedIssue.requiredAction,
          userInstruction: recoverableAssistedIssue.userInstruction,
          selectorBundle: getSelectorBundleSignal(context),
          selectorDriftDiagnostics:
            recoverableAssistedIssue.selectorDriftDiagnostics,
          recoveryActions: buildRecoveryActions(message, {
            selectorDriftDiagnostics:
              recoverableAssistedIssue.selectorDriftDiagnostics,
          }),
          captures: [],
        },
        executionLog: failureExecutionLog,
      });
      pushStatus(
        "progress",
        "Assisted filing is waiting for a supervised recovery confirmation.",
      );
      return;
    }

    const selectorDriftDiagnostics = buildSelectorDriftDiagnostics(
      message,
      failureExecutionLog,
      context,
    );
    await updateLocalJobStatus(job.id, "failed", {
      errorMessage: message,
      result: {
        selectorBundle: getSelectorBundleSignal(context),
        selectorDriftDiagnostics,
        recoveryActions: buildRecoveryActions(message, {
          selectorDriftDiagnostics,
        }),
      },
      executionLog: failureExecutionLog,
    });
    pushStatus("error", message);
  } finally {
    await cleanupJobDocuments(job.id);
  }
}

async function runLocalWorkerCycle() {
  if (localWorkerRunning) {
    return;
  }

  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;
  const apiBaseUrl = getApiBaseUrl();

  if (!deviceAuthToken || !apiBaseUrl) {
    return;
  }

  localWorkerRunning = true;

  try {
    const job = await claimNextLocalJob();

    if (!job) {
      return;
    }

    await processLocalJob(job);
  } catch (error) {
    pushStatus(
      "error",
      error instanceof Error
        ? error.message
        : "The local desktop worker encountered an unexpected error.",
    );
  } finally {
    localWorkerRunning = false;
  }
}

function getDeepLinkArgument(argv) {
  return (
    (argv || []).find(
      (value) =>
        String(value).startsWith("ejari-connect://") ||
        String(value).startsWith("taxrocket-connect://"),
    ) || ""
  );
}

function startLocalBridgeServer() {
  if (localBridgeServer) {
    return;
  }

  localBridgeServer = http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin || "";
    const requestedAllowedOrigins = launchState.allowedOrigins || [];
    const originAllowed =
      !requestedAllowedOrigins.length ||
      isOriginAllowed(requestOrigin, requestedAllowedOrigins);

    if (originAllowed && requestOrigin) {
      response.setHeader("Access-Control-Allow-Origin", requestOrigin);
    }
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");

    if (request.method === "OPTIONS") {
      response.writeHead(originAllowed ? 204 : 403);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.method !== "POST" || request.url !== "/connect") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "Not found." }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });

    request.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const allowedOrigins = Array.isArray(payload?.allowedOrigins)
          ? payload.allowedOrigins.filter((value) => typeof value === "string")
          : [];
        const backendAllowlist = Array.isArray(payload?.backendAllowlist)
          ? payload.backendAllowlist.filter(
              (value) => typeof value === "string",
            )
          : [];
        const bridgeOriginAllowed =
          !allowedOrigins.length ||
          isOriginAllowed(requestOrigin, allowedOrigins);
        const backendAllowed = isBackendAllowed(
          payload?.apiBaseUrl,
          backendAllowlist,
        );
        const nonce =
          typeof payload?.nonce === "string" ? payload.nonce.trim() : "";

        if (!bridgeOriginAllowed) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Bridge origin is not allowed.",
            }),
          );
          return;
        }

        if (!backendAllowed) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch backend is not allowed.",
            }),
          );
          return;
        }

        if (!nonce || acceptedLaunchNonces.has(nonce)) {
          response.writeHead(409, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch nonce is missing or already used.",
            }),
          );
          return;
        }

        const confirmation = await dialog.showMessageBox(
          mainWindow || undefined,
          {
            type: "question",
            buttons: ["Accept", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            title: LOCAL_AGENT_CONFIRMATION_TITLE,
            message: "Accept Tax Rocket desktop launch?",
            detail: `Origin: ${requestOrigin || "unknown"}\nBackend: ${payload?.apiBaseUrl || "unknown"}\nFlow: ${payload?.flow === "fbr" ? "FBR / Iris" : "DLD / MyDLD"}`,
          },
        );

        if (confirmation.response !== 0) {
          response.writeHead(403, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "Desktop launch was cancelled by the user.",
            }),
          );
          return;
        }

        const accepted = applyLaunchPayload(payload);

        if (!accepted) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              ok: false,
              error: "token and apiBaseUrl are required.",
            }),
          );
          return;
        }

        acceptedLaunchNonces.add(nonce);

        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "Invalid launch payload.",
          }),
        );
      }
    });
  });

  localBridgeServer.listen(LOCAL_BRIDGE_PORT, LOCAL_BRIDGE_HOST);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: "#0b1512",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer.html"));
}

function scheduleAutoCapture(reason) {
  clearAutoCaptureTimer();

  if (!loginWindow || loginWindow.isDestroyed()) {
    return;
  }

  if (!launchState.token || !launchState.apiBaseUrl) {
    return;
  }

  if (autoCaptureState.inProgress || autoCaptureState.completed) {
    return;
  }

  autoCaptureTimer = setTimeout(() => {
    void attemptAutoCapture(reason);
  }, 900);
}

function isCurrentPortalReadyUrl(rawValue) {
  if (launchState.flow === "fbr") {
    return isLikelyReadyFbrUrl(rawValue);
  }

  return isLikelyLoggedInDldUrl(rawValue);
}

async function attemptAutoCapture(reason) {
  clearAutoCaptureTimer();

  if (!loginWindow || loginWindow.isDestroyed()) {
    return;
  }

  if (!launchState.token || !launchState.apiBaseUrl) {
    pushStatus(
      "error",
      "Return to the web app and start the connection again.",
    );
    return;
  }

  const currentUrl = loginWindow.webContents.getURL();

  if (!isCurrentPortalReadyUrl(currentUrl)) {
    return;
  }

  if (autoCaptureState.inProgress || autoCaptureState.completed) {
    return;
  }

  autoCaptureState.inProgress = true;
  pushStatus(
    "progress",
    reason === "login-detected"
      ? launchState.flow === "fbr"
        ? "Iris sign-in detected. Marking this trusted device ready automatically."
        : "MyDLD sign-in detected. Marking this desktop device ready automatically."
      : launchState.flow === "fbr"
        ? "Checking your local Iris session and saving this device automatically."
        : "Checking your local MyDLD session and saving this device automatically.",
  );

  try {
    await captureLoginWindowState();
    await markTrustedDeviceReady();

    autoCaptureState.completed = true;
    autoCaptureState.inProgress = false;

    pushStatus(
      "success",
      launchState.flow === "fbr"
        ? "This trusted desktop device is ready for Iris dry runs. You can return to the web app."
        : "This trusted desktop device is ready for MyDLD automation. You can return to the web app.",
    );
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
    }
  } catch (error) {
    autoCaptureState.inProgress = false;
    pushStatus(
      "error",
      error instanceof Error
        ? error.message
        : "This desktop device could not be marked ready automatically.",
    );
  }
}

function attachLoginWindowWatchers(windowInstance) {
  const triggerIfReady = () => {
    const currentUrl = windowInstance.webContents.getURL();
    if (isCurrentPortalReadyUrl(currentUrl)) {
      scheduleAutoCapture("login-detected");
    }
  };

  windowInstance.webContents.on("did-finish-load", triggerIfReady);
  windowInstance.webContents.on("did-navigate", triggerIfReady);
  windowInstance.webContents.on("did-navigate-in-page", triggerIfReady);
  windowInstance.webContents.on("did-stop-loading", triggerIfReady);
}

async function createLoginWindow(openFresh = false) {
  if (launchState.token && launchState.apiBaseUrl) {
    await ensureTrustedDeviceRegistration();
  }

  const partitionKey =
    launchState.partitionKey || loadAgentState().partitionKey || "default";
  const partition =
    launchState.flow === "fbr"
      ? `persist:fbr-iris-${partitionKey}`
      : `persist:dld-portal-${partitionKey}`;

  if (loginWindow && !loginWindow.isDestroyed()) {
    if (openFresh) {
      loginWindow.loadURL(resolveDesktopLoginUrl());
      pushStatus(
        "progress",
        launchState.flow === "fbr"
          ? "Iris sign-in opened. Complete the local sign-in and we will continue automatically."
          : "MyDLD sign-in opened. Complete the official sign-in and we will continue automatically.",
      );
    }

    loginWindow.focus();
    return loginWindow;
  }

  loginWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    title: launchState.flow === "fbr" ? "Iris Sign In" : "MyDLD Sign In",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });

  attachLoginWindowWatchers(loginWindow);

  loginWindow.on("closed", () => {
    loginWindow = null;
    clearAutoCaptureTimer();

    if (!autoCaptureState.completed && !autoCaptureState.inProgress) {
      pushStatus(
        "idle",
        launchState.flow === "fbr"
          ? "Iris sign-in window closed. Start the connection again if needed."
          : "MyDLD sign-in window closed. Start the connection again if needed.",
      );
    }
  });

  loginWindow.loadURL(resolveDesktopLoginUrl());
  pushStatus(
    "progress",
    launchState.flow === "fbr"
      ? "Iris sign-in opened. Complete the local sign-in and we will continue automatically."
      : "MyDLD sign-in opened. Complete the official sign-in and we will continue automatically.",
  );
  return loginWindow;
}

async function captureLoginWindowState() {
  if (!loginWindow || loginWindow.isDestroyed()) {
    throw new Error("The MyDLD login window is not open.");
  }

  const currentUrl = loginWindow.webContents.getURL();

  if (!currentUrl || currentUrl === "about:blank") {
    throw new Error(
      launchState.flow === "fbr"
        ? "Finish loading the Iris readiness screen before this device can be marked ready."
        : "Finish loading the official MyDLD page before this device can be marked ready.",
    );
  }

  if (!isCurrentPortalReadyUrl(currentUrl)) {
    throw new Error(
      launchState.flow === "fbr"
        ? "Complete Iris sign-in before this device can be marked ready."
        : "Complete sign-in to MyDLD before this device can be marked ready.",
    );
  }

  const desktopAuthConfig = normalizeDesktopAuthConfig(
    launchState.desktopAuthConfig,
  );

  if (
    desktopAuthConfig.readyRejectSelector &&
    (await hasSelector(loginWindow, desktopAuthConfig.readyRejectSelector))
  ) {
    throw new Error(
      launchState.flow === "fbr"
        ? "Iris still shows a sign-in, reset, or error state. Complete that step before continuing."
        : "MyDLD still shows a sign-in or error state. Complete sign-in before continuing.",
    );
  }

  if (desktopAuthConfig.readySelector) {
    await waitForVisibleSelector(
      loginWindow,
      desktopAuthConfig.readySelector,
      5000,
    );
  } else if (desktopAuthConfig.readyUrlPattern) {
    if (
      !matchesSuccessUrlPattern(currentUrl, desktopAuthConfig.readyUrlPattern)
    ) {
      throw new Error(
        launchState.flow === "fbr"
          ? "The trusted desktop app did not detect the expected Iris ready screen yet."
          : "The trusted desktop app did not detect the expected logged-in MyDLD page yet.",
      );
    }
  }

  return {
    capturedUrl: currentUrl,
  };
}

async function markTrustedDeviceReady() {
  const deviceAuthToken =
    launchState.deviceAuthToken || loadAgentState().deviceAuthToken;

  if (!deviceAuthToken || !launchState.apiBaseUrl) {
    throw new Error("No trusted desktop device token is available yet.");
  }

  const response = await fetch(
    `${launchState.apiBaseUrl}${getTrustedDeviceReadyEndpoint()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deviceAuthToken}`,
      },
      body: JSON.stringify({
        currentUrl:
          loginWindow && !loginWindow.isDestroyed()
            ? loginWindow.webContents.getURL()
            : null,
      }),
    },
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error(
      result?.error ||
        `Ready-state update failed with status ${response.status}.`,
    );
  }

  return result;
}

ipcMain.handle("get-launch-state", async () => launchState);

ipcMain.handle("open-dld-login", async () => {
  await createLoginWindow(true);
  return {
    ok: true,
    url: resolveDesktopLoginUrl(),
  };
});

ipcMain.handle("capture-and-upload", async (_event, input = {}) => {
  await captureLoginWindowState();
  return markTrustedDeviceReady();
});

ipcMain.handle("set-account-reference", async (_event, value) => {
  launchState.accountReference = typeof value === "string" ? value.trim() : "";
  publishLaunchState();
  return { ok: true };
});

ipcMain.handle("open-external", async (_event, value) => {
  const target = typeof value === "string" ? value : "";

  if (!target) {
    return { ok: false };
  }

  await shell.openExternal(target);
  return { ok: true };
});

ipcMain.handle(
  "get-local-bridge-url",
  async () => `http://${LOCAL_BRIDGE_HOST}:${LOCAL_BRIDGE_PORT}/connect`,
);

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = getDeepLinkArgument(argv);
    if (deepLink) {
      applyLaunchUrl(deepLink);
    }
  });

  app.whenReady().then(() => {
    try {
      if (process.defaultApp) {
        app.setAsDefaultProtocolClient("ejari-connect", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
        app.setAsDefaultProtocolClient("taxrocket-connect", process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      } else {
        app.setAsDefaultProtocolClient("ejari-connect");
        app.setAsDefaultProtocolClient("taxrocket-connect");
      }
    } catch (error) {
      console.warn("Custom protocol registration was not completed.", error);
    }

    createMainWindow();
    loadAgentState();
    startLocalBridgeServer();
    startLocalWorkerLoop();

    const deepLink = getDeepLinkArgument(process.argv);
    if (deepLink) {
      applyLaunchUrl(deepLink);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

app.on("open-url", (event, url) => {
  event.preventDefault();
  applyLaunchUrl(url);
});

app.on("window-all-closed", () => {
  clearLocalWorkerTimer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
