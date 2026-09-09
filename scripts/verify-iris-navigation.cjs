const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
after(async () => {
  await browser?.close();
});

// Synthetic fixture based only on the supplied log's menu LABELS. No customer
// identity, financial data, authentication or requests to FBR are used.
const dashboard = (dialog = "") => `<!doctype html><html><head><style>
body{font:16px sans-serif;margin:20px}a,button{display:inline-block;padding:9px;margin:4px;cursor:pointer}
a{background:#eee}th,td{padding:10px}[hidden]{display:none!important}
[role=dialog]{position:fixed;top:15%;left:20%;width:420px;padding:24px;background:#fff;border:2px solid #aaa;z-index:20}
.modal-backdrop{position:fixed;inset:0;background:#0004;z-index:10}
</style></head><body>
<nav><a id="homeLink" href="/dashboard">Home</a><a id="navbarDropdown1" onclick="actions.push('assets')">Assets Declaration</a>
<a id="navbarDropdown1" onclick="actions.push('declaration')">Declaration</a><button>person_pinarrow_drop_down</button>
<a>PRIVATE TEST TAXPAYER NAME</a></nav>
<a id="inbox" class="active">Inbox (Correspondence from FBR)</a>
<a id="draft" onclick="actions.push('draft');this.classList.add('active');document.querySelector('#inbox').classList.remove('active');setTimeout(()=>document.querySelector('#it').hidden=false,150)">Draft (Unsubmitted Documents)</a>
<a>Completed Tasks</a><button id="it" hidden onclick="actions.push('it');this.classList.add('active');setTimeout(()=>document.querySelector('#grid').hidden=false,200)">IT DECLARATION (2)</button>
<table id="grid" hidden><thead><tr><th>Task</th><th>Tax Period</th><th>Action</th></tr></thead><tbody>
<tr class="doubleclick" ondblclick="actions.push('OPEN_RETURN')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2025 - 30-Jun-2026</td><td><button class="edit" onclick="actions.push('EDIT_RETURN')">Edit</button></td></tr>
<tr class="doubleclick" ondblclick="actions.push('OPEN_WRONG_YEAR')"><td>114(1) (Return of Income filed voluntarily for complete year)</td><td>01-Jul-2024 - 30-Jun-2025</td><td><button onclick="actions.push('DELETE_RETURN')">Delete</button></td></tr>
</tbody></table>
<input id="search" value="PRIVATE_SEARCH_VALUE"><button onclick="actions.push('SUBMIT')">Submit</button>
<script>window.actions=[];localStorage.setItem('token','PRIVATE_STORAGE_TOKEN');</script>${dialog}</body></html>`;

async function withPage(html, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // No live network: every request, including the initial official-looking
  // fixture URL, is intercepted locally.
  await context.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: html }),
  );
  await page.goto(
    "https://iris.fbr.gov.pk/dashboard?token=PRIVATE_URL_TOKEN#PRIVATE_HASH",
  );
  const mainFrame = {
    get url() {
      return page.url();
    },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const windowInstance = {
    isDestroyed: () => false,
    webContents: {
      mainFrame,
      getURL: () => page.url(),
      executeJavaScript: mainFrame.executeJavaScript,
    },
  };
  try {
    await run(page, windowInstance);
  } finally {
    await context.close();
  }
}

const welcome = `<div class="modal-backdrop" id="backdrop"></div><section role="dialog" id="promo">
<h2>Submit Your Income Tax Return</h2><p>Tax year 2026 — Last Date</p>
<button aria-label="Close" onclick="actions.push('close_welcome');document.querySelector('#backdrop').remove();document.querySelector('#promo').remove()">×</button></section>`;

test("live inspection closes ONLY identified welcome and waits for Angular draft tabs/grid", async () => {
  await withPage(dashboard(welcome), async (page, windowInstance) => {
    const steps = [];
    const result = await navigation.inspectNavigation(windowInstance, {
      taxYear: 2026,
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_inspection");
    assert.deepEqual(await page.evaluate("actions"), [
      "close_welcome",
      "draft",
      "it",
    ]);
    const frame = result.inspection.frames[0];
    assert.equal(frame.rows.length, 2);
    assert.deepEqual(frame.rows[0].form.codes, ["114(1)"]);
    assert.equal(frame.rows[0].requestedYearMentioned, true);
    assert.equal(frame.rows[1].requestedYearMentioned, false);
    assert.deepEqual(frame.rows[0].candidatePeriods, [
      "01-Jul-2025",
      "30-Jun-2026",
    ]);
    assert.ok(steps.includes("draft_inventory"));
    assert.equal(
      await page.locator("#search").inputValue(),
      "PRIVATE_SEARCH_VALUE",
    );
    const exported = JSON.stringify(result);
    for (const secret of [
      "PRIVATE TEST",
      "PRIVATE_SEARCH_VALUE",
      "PRIVATE_STORAGE_TOKEN",
      "PRIVATE_URL_TOKEN",
      "PRIVATE_HASH",
    ]) {
      assert.ok(!exported.includes(secret), `Must not export ${secret}`);
    }
  });
});

test("an unknown modal is not hidden, dismissed or bypassed", async () => {
  const unknown = `<div class="modal-backdrop"></div><div role="dialog" id="unknown"><img alt="" width="80" height="40"><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(unknown), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(await page.locator("#unknown").isVisible(), true);
  });
});

test("OTP / PIN dialogs are protected even if they also mention a welcome promotion", async () => {
  const verification = `<div class="modal-backdrop"></div><div role="dialog" id="otp"><p>Submit Your Income Tax Return for tax year 2026</p><label>OTP / PIN <input name="otp" value="PRIVATE_OTP_VALUE"></label><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(verification), async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.equal(result.inspection.frames[0].dialogs[0].kind, "protected");
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_OTP_VALUE"));
    assert.equal(await page.locator("#otp").isVisible(), true);
  });
});

test("a final-confirmation dialog cannot masquerade as an auto-dismissible welcome", async () => {
  const final = `<div role="dialog" id="final"><p>Submit Your Income Tax Return for tax year 2026</p><button onclick="actions.push('SUBMIT')">Submit</button><button aria-label="Close" onclick="actions.push('unsafe_close')">×</button></div>`;
  await withPage(dashboard(final), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "close-welcome",
    });
    assert.equal(result.frames[0].actionResult.status, "manual_close_required");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("reappearing welcome popup retries are bounded and never navigate behind it", async () => {
  const recurring = welcome.replace(
    "document.querySelector('#promo').remove()",
    "document.querySelector('#promo').remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend',window.recurringMarkup),100)",
  );
  await withPage(dashboard(recurring), async (page, win) => {
    await page.evaluate(() => {
      window.recurringMarkup =
        document.querySelector("#backdrop").outerHTML +
        document.querySelector("#promo").outerHTML;
    });
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(
      await page.evaluate("actions"),
      Array(4).fill("close_welcome"),
    );
    assert.equal(
      await page.evaluate("Boolean(window.__taxrocketPopupGuardTimer)"),
      false,
    );
  });
});

test("body/domain/search input do not prove login or return readiness", async () => {
  await withPage(
    `<body><input type="password" name="password" value="PRIVATE_PASSWORD"><button>Login</button></body>`,
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
      assert.equal(result.requiredAction, "session_reconnect");
      assert.equal(navigation.isAuthenticated(result.inspection), false);
      assert.ok(!JSON.stringify(result).includes("PRIVATE_PASSWORD"));
    },
  );
  // A bare search box is NOT a login prompt. Reporting session_reconnect here
  // would tell the user to sign in again when they may already be signed in;
  // the honest answer is that the screen could not be identified.
  await withPage(`<body><input id="search"></body>`, async (_page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_readiness_unverified");
    assert.equal(navigation.isAuthenticated(result.inspection), false);
  });
});

test("duplicate navbar ids are resolved by exact semantic action, never first id match", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(result.frames[0].actionResult.status, "clicked");
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
    await page.evaluate(() => {
      const extra = document.querySelector("#navbarDropdown1").cloneNode(true);
      extra.textContent = "Declaration";
      document.querySelector("nav").appendChild(extra);
      window.actions = [];
    });
    const ambiguous = await navigation.probeFrames(win, {
      action: "declaration-menu",
    });
    assert.equal(ambiguous.frames[0].actionResult.status, "ambiguous");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("only approved HTTPS hosts and actual Electron child-frame API are inspected", async () => {
  assert.equal(
    navigation.isAllowedPortalUrl("https://iris.fbr.gov.pk/dashboard"),
    true,
  );
  for (const url of [
    "https://iris.fbr.gov.pk.evil.example",
    "http://iris.fbr.gov.pk",
    "https://evil.example/?iris.fbr.gov.pk",
    "file:///mock.html",
  ]) {
    assert.equal(navigation.isAllowedPortalUrl(url), false);
  }
  const called = [];
  const main = {
    url: "https://iris.fbr.gov.pk/dashboard",
    executeJavaScript: async () => {
      called.push("main");
      return { authenticated: true };
    },
  };
  const child = {
    url: "https://iris.fbr.gov.pk/return",
    executeJavaScript: async () => {
      called.push("child");
      return {};
    },
  };
  const external = {
    url: "https://help.example",
    executeJavaScript: async () => {
      throw new Error("MUST NOT READ");
    },
  };
  main.framesInSubtree = [main, child, external];
  const result = await navigation.probeFrames({
    isDestroyed: () => false,
    webContents: { mainFrame: main },
  });
  assert.deepEqual(called, ["main", "child"]);
  assert.equal(result.frames[2].skipped, "unapproved_origin");
  assert.deepEqual(await navigation.probeFrames(null), {
    frames: [],
    unavailable: "window_closed",
  });
});

test("read-only action whitelist cannot be used to submit or click arbitrary selectors", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, {
      action: "submit",
      selector: "button",
    });
    assert.equal(result.frames[0].actionResult.status, "unsupported_action");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

const mainSource = fs.readFileSync(
  path.join(__dirname, "../electron-connect/main.js"),
  "utf8",
);
const ast = ts.createSourceFile(
  "main.js",
  mainSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function functionSource(name) {
  const found = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `Function ${name} exists`);
  return found.getText(ast);
}
function sandbox(names, extras = {}) {
  const ctx = vm.createContext({
    console,
    Promise,
    Date,
    setTimeout,
    clearTimeout,
    ...extras,
  });
  for (const name of names) vm.runInContext(functionSource(name), ctx);
  return ctx;
}

test("main worker is single-flight even while the claim request is still pending", async () => {
  let release;
  let calls = 0;
  const ctx = sandbox(["runLocalWorkerCycle"], {
    localWorkerRunning: false,
    workerIdleAnnounced: false,
    launchState: { deviceAuthToken: "test-token" },
    getApiBaseUrl: () => "https://test.invalid",
    loadAgentState: () => ({}),
    pushStatus: () => {},
    claimNextLocalJob: () => {
      calls++;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = ctx.runLocalWorkerCycle();
  await ctx.runLocalWorkerCycle();
  assert.equal(calls, 1);
  assert.equal(ctx.localWorkerRunning, true);
  release(null);
  await first;
  assert.equal(ctx.localWorkerRunning, false);
});

test("main retains SAME live BrowserWindow on start/reconnect without loadURL", async () => {
  const calls = [];
  const win = {
    isDestroyed: () => false,
    taxRocketPartition: "persist:test",
    webContents: { getURL: () => "https://iris.fbr.gov.pk/dashboard" },
    loadURL: async () => calls.push("load"),
    show: () => {},
    focus: () => {},
    setTitle: () => {},
    close: () => calls.push("close"),
  };
  const ctx = sandbox(["createLoginWindow", "ensureWorkerWindow"], {
    loginWindowPromise: null,
    loginWindow: win,
    workerWindow: null,
    realPortalMode: true,
    AGENT_BUILD_TAG: "test",
    irisNavigation: navigation,
    launchState: {
      flow: "fbr",
      token: "test",
      apiBaseUrl: "https://test.invalid",
      deviceAuthToken: "registered",
      desktopAuthConfig: { useMockIris: false },
    },
    getWorkerPartition: () => "persist:test",
    resolveDesktopLoginUrl: () => "https://iris.fbr.gov.pk/",
    scheduleAutoCapture: () => {},
    startLocalWorkerLoop: () => {},
  });
  assert.equal(await ctx.createLoginWindow(true), win);
  assert.equal(await ctx.ensureWorkerWindow(), win);
  assert.deepEqual(calls, []);
});

test("real assisted AND dry-run dispatch to inspection before any legacy fill/submit code", async () => {
  // Phase 1 put real-portal autofill behind TAXROCKET_REAL_AUTOFILL. With the
  // flag off (the default) both flows must still behave exactly as before:
  // inspection only, and the legacy mock filler never reached.
  let called = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "off",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => {
        called++;
        return { paused: true };
      },
      runRealIrisAutofill: () => {
        throw new Error("Autofill must not run while the flag is off");
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal((await ctx.runLocalTaxAssistedFilingFlow({}, {})).paused, true);
  assert.equal((await ctx.runLocalTaxDryRunFlow({ job: {} })).paused, true);
  assert.equal(called, 2);
});

test("a paused navigation checkpoint is never overridden by autofill", async () => {
  // Even with autofill enabled, a pause (OTP, PIN, unknown modal, wrong route)
  // must be returned untouched — filling a form the user has not been driven to
  // is how values land in the wrong return.
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "live",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: true,
        pauseAction: "portal_popup",
      }),
      runRealIrisAutofill: async () => {
        autofillCalls++;
        return { executionLog: [], result: {} };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );
  assert.equal(
    (await ctx.runLocalTaxAssistedFilingFlow({}, {})).pauseAction,
    "portal_popup",
  );
  assert.equal(
    (await ctx.runLocalTaxDryRunFlow({ job: {} })).pauseAction,
    "portal_popup",
  );
  assert.equal(autofillCalls, 0, "autofill must not run behind a pause");
});

test("autofill runs only after an un-paused navigation check, and merges its log", async () => {
  let autofillCalls = 0;
  const ctx = sandbox(
    [
      "runLocalTaxAssistedFilingFlow",
      "runLocalTaxDryRunFlow",
      "finishNavigationOnly",
    ],
    {
      realPortalMode: true,
      getRealAutofillMode: () => "dry",
      updateLocalJobStatus: async () => {},
      runLocalIrisNavigationCheck: async () => ({
        paused: false,
        executionLog: [{ step: "nav" }],
        result: { navigated: true },
      }),
      runRealIrisAutofill: async (_ctx, _job, mode) => {
        autofillCalls++;
        return {
          executionLog: [{ step: "real_autofill_result" }],
          result: { mode, summary: { filled: 3 } },
        };
      },
      ensureWorkerWindow: () => {
        throw new Error("Legacy filler must not run");
      },
    },
  );

  const assisted = await ctx.runLocalTaxAssistedFilingFlow({}, {});
  assert.equal(assisted.paused, false);
  assert.equal(assisted.result.autofill.mode, "dry");
  assert.equal(
    assisted.result.navigated,
    true,
    "navigation result must be preserved",
  );
  // Arrays come back from the vm realm, so deepEqual's realm check would fail
  // on structurally identical values. Compare the joined steps instead.
  assert.equal(
    assisted.executionLog.map((e) => e.step).join(","),
    "nav,real_autofill_result",
  );

  const dryRun = await ctx.runLocalTaxDryRunFlow({ job: {} });
  assert.equal(dryRun.result.autofill.summary.filled, 3);
  assert.equal(autofillCalls, 2);
});

test("CSS timeout does not starve a valid text navigation fallback", async () => {
  await withPage(dashboard(), async (page, win) => {
    const ctx = sandbox([
      "splitSelectorAlternatives",
      "findAndClickByText",
      "clickSelectorWithTextSupport",
    ]);
    await ctx.clickSelectorWithTextSupport(
      win,
      "#absent-selector, text:Declaration",
      500,
    );
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
  });
});

test("legacy menu helper clicks the successfully resolved selector", async () => {
  for (const [fn, key] of [
    ["navigateIrisTopMenu", "topMenuSelector"],
    ["navigateIrisLeftCategory", "leftCategorySelector"],
  ]) {
    const clicks = [];
    const ctx = sandbox([fn], {
      setTimeout: (callback) => {
        callback();
      },
      buildActionSelectorChain: () => ["#menu"],
      trySelectorsInPriority: async () => ({ selector: "#menu" }),
      clickSelector: async (_win, selector) => clicks.push(selector),
    });
    await ctx[fn]({}, { [key]: "#menu" });
    assert.deepEqual(clicks, ["#menu"]);
  }
});

test("context failures are reported and logged instead of leaving a job silently queued", async () => {
  const calls = [];
  const ctx = sandbox(["processLocalJob"], {
    loadLocalJobContext: async () => {
      throw new Error("Queued approved packet unavailable");
    },
    saveFailureDump: async () => null,
    captureDomEvidence: async () => ({ frames: [] }),
    workerWindow: null,
    activeJobExecutionLog: null,
    STANDARD_LOG_STEPS: { FAILURE: "failure" },
    classifyRecoverableAssistedIssue: () => null,
    buildSelectorDriftDiagnostics: () => null,
    getSelectorBundleSignal: () => null,
    buildRecoveryActions: () => [],
    updateLocalJobStatus: async (_id, status) => calls.push(status),
    writeJobLogToDisk: async () => {
      calls.push("log");
      return null;
    },
    cleanupJobDocuments: async () => calls.push("cleanup"),
    pushStatus: () => {},
  });
  await ctx.processLocalJob({
    id: "job-test",
    type: "tax_assisted_filing",
    status: "created",
  });
  assert.deepEqual(calls, ["failed", "log", "cleanup"]);
});

// ─── Phase 1.5a: setup-dialog deadlock ──────────────────────────────────────
// The agent opens the "Normal Return (Ind/AOP/COY)" dialog itself, then its own
// sensitiveControl heuristic classified it as protected, so every retry paused
// on portal_popup and close-welcome (a no-op here) looped forever.

const setupDialog = (
  extra = "",
) => `<div class="modal-backdrop" id="backdrop" style="pointer-events:none"></div>
<section role="dialog" class="mat-mdc-dialog-container" id="setup">
<h3 role="heading">Normal Return (Ind/AOP/COY)</h3>
<label>Period</label>
<input type="radio" name="period" id="p1"><label for="p1">01-Jul-2025 - 30-Jun-2026</label>
${extra}
<button onclick="actions.push('setup_continue')">Continue</button>
</section>`;

async function dialogKinds(html) {
  let kinds;
  await withPage(dashboard(html), async (_page, win) => {
    const probe = await navigation.probeFrames(win, {
      action: "inspect",
      taxYear: 2026,
    });
    kinds = probe.frames[0];
  });
  return kinds;
}

test("Phase 1.5a: a recognised setup dialog is tagged 'setup' and does not block navigation", async () => {
  const frame = await dialogKinds(setupDialog());
  assert.equal(frame.dialogs.length, 1);
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.setupDialogOnly, true);
  assert.equal(frame.hasBlockingOverlay, false);
});

test("Phase 1.5a: a setup dialog carrying an OTP field stays protected and blocking", async () => {
  const frame = await dialogKinds(
    setupDialog('<label>OTP</label><input type="text" name="otp">'),
  );
  assert.equal(frame.dialogs[0].kind, "protected");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a setup dialog carrying a commit control stays blocking", async () => {
  const frame = await dialogKinds(setupDialog("<button>Submit</button>"));
  assert.notEqual(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: an unrecognised dialog still blocks exactly as before", async () => {
  const frame = await dialogKinds(
    `<section role="dialog" id="mystery"><h3>Something unfamiliar</h3><button>Ok</button></section>`,
  );
  assert.equal(frame.dialogs[0].kind, "unknown");
  assert.equal(frame.setupDialogOnly, false);
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: a live backdrop blocks even when the only dialog is setup", async () => {
  const frame = await dialogKinds(
    `<div class="modal-backdrop" id="live"></div>` + setupDialog(),
  );
  assert.equal(frame.dialogs[0].kind, "setup");
  assert.equal(frame.hasBlockingOverlay, true);
});

test("Phase 1.5a: the setup dialog reaches the stage machine instead of looping on close-welcome", async () => {
  await withPage(dashboard(setupDialog()), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      state: { newEntryOpened: true },
      onStep: (step) => steps.push(String(step)),
    });
    // The deadlock signature was: portal_popup plus four no-op close_welcome clicks.
    assert.notEqual(result.requiredAction, "portal_popup");
    assert.equal(
      (await page.evaluate("actions")).filter((a) => a === "close_welcome")
        .length,
      0,
    );
    assert.ok(
      steps.some((s) => s.startsWith("new_return_setup")),
      `stage machine was reached, got: ${steps.join(", ")}`,
    );
  });
});

// ─── Phase 1.5b: economic-transactions gate ─────────────────────────────────
// Reached from the blue dashboard tile at /nitr/summary-economic-transactions.
// Read-only to the agent: residency (ITO s.82-84) and the income-source ticks
// are the taxpayer's own declarations.

const gate = ({ checked = false, residency = false, enabled = false } = {}) =>
  `<!doctype html><html><body><app-summary-economic-transactions>
<app-source-checkbox><mat-checkbox><input type="checkbox" ${checked ? "checked" : ""}></mat-checkbox>Income from Salary</app-source-checkbox>
<app-source-checkbox><mat-checkbox><input type="checkbox"></mat-checkbox>Income from Business</app-source-checkbox>
<mat-radio-group aria-label="Select Residential Status">
<mat-radio-button><input type="radio" name="res" value="yes" ${residency ? "checked" : ""}></mat-radio-button>Yes
<mat-radio-button><input type="radio" name="res" value="no"></mat-radio-button>No
</mat-radio-group>
<div class="btn-start-wrapper">
<button class="btn btn-start" ${enabled ? "" : "disabled"}>Start Return Filling</button>
<button type="button" aria-label="Start Return Filling" class="btn-start-overlay"></button>
</div></app-summary-economic-transactions>
<script>window.actions=[]</script></body></html>`;

test("Phase 1.5b: the unanswered gate is recognised, authenticated, and lists what is missing", async () => {
  await withPage(gate(), async (page, win) => {
    const steps = [];
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
      onStep: (step) => steps.push(step),
    });
    assert.equal(result.requiredAction, "portal_economic_transactions_gate");
    assert.equal(result.economicTransactionsGate.ready, false);
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "income sources",
      "tax residency",
    ]);
    assert.equal(navigation.isAuthenticated(result.inspection), true);
    assert.equal(
      result.inspection.frames[0].readiness.evidence,
      "economic_transactions_gate",
    );
    // The agent must never answer the gate on the taxpayer's behalf.
    assert.deepEqual(await page.evaluate("actions"), []);
    assert.equal(
      await page.evaluate("document.querySelectorAll('input:checked').length"),
      0,
    );
  });
});

test("Phase 1.5b: a partially answered gate reports only the outstanding half", async () => {
  await withPage(gate({ checked: true }), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.deepEqual(result.economicTransactionsGate.missing, [
      "tax residency",
    ]);
    assert.deepEqual(result.economicTransactionsGate.selectedSources, [
      "Income from Salary",
    ]);
  });
});

test("Phase 1.5b: an answered gate reports ready and still refuses to click Start", async () => {
  await withPage(
    gate({ checked: true, residency: true, enabled: true }),
    async (page, win) => {
      const result = await navigation.inspectNavigation(win, {
        taxYear: 2026,
        openReturn: true,
        taxpayerIdentifier: "1234567890123",
      });
      assert.equal(result.requiredAction, "portal_economic_transactions_gate");
      assert.equal(result.economicTransactionsGate.ready, true);
      assert.equal(result.economicTransactionsGate.residencySelected, true);
      assert.deepEqual(await page.evaluate("actions"), []);
    },
  );
});

test("Phase 1.5b: the gate snapshot never carries the opaque session token", async () => {
  await withPage(gate(), async (_page, win) => {
    const result = await navigation.inspectNavigation(win, {
      taxYear: 2026,
      openReturn: true,
      taxpayerIdentifier: "1234567890123",
    });
    assert.ok(!JSON.stringify(result).includes("PRIVATE_URL_TOKEN"));
    assert.ok(!JSON.stringify(result).includes("PRIVATE_HASH"));
  });
});

test("Phase 1.5: the in-page stage classifier mirror cannot drift from the module original", async () => {
  // portalProbe is serialized into the renderer, so it carries its own copy of
  // classifyNewReturnSetupStage. Both must agree on every stage.
  const cases = [
    { nodeLabels: ["Normal Return (Ind/AOP/COY)"], expected: "menu" },
    {
      prompts: ["Normal Return", "Simplified Return"],
      expected: "return_type",
    },
    { prompts: ["Resident"], expected: "residency" },
    { actions: ["Accept and Continue"], expected: "accept_continue" },
    { prompts: ["Period"], actions: ["Continue"], expected: "period" },
    { prompts: ["Something else"], expected: null },
    {
      documentPresent: true,
      nodeLabels: ["Normal Return (Ind/AOP/COY)"],
      expected: null,
    },
  ];
  const source = navigation.portalProbe.toString();
  const mirror = source.slice(
    source.indexOf("const classifySetupStage"),
    source.indexOf("const isSafeAutoAdvanceStage"),
  );
  const classify = new Function(
    "input",
    `const setupLabel=(v)=>String(v||"").replace(/\\s+/g," ").trim().toLowerCase();${mirror}return classifySetupStage(input);`,
  );
  for (const { expected, ...input } of cases) {
    const descriptor = {
      documentPresent: false,
      prompts: [],
      actions: [],
      nodeLabels: [],
      ...input,
    };
    assert.equal(navigation.classifyNewReturnSetupStage(descriptor), expected);
    assert.equal(
      classify(descriptor),
      expected,
      `mirror disagrees for ${JSON.stringify(input)}`,
    );
  }
});

// ─── Phase 1.6: complete the tour, then let autofill run ────────────────────
// Dry-run 2026-09-09 reached Computations then paused on "Personal Assets /
// Liabilities: section panel not_found". The 116 Wealth Statement is a separate
// document, not a panel in the 114(1) workflow, so the tour could never finish
// and autofill was unreachable.

test("Phase 1.6: the section plan excludes the 116 Wealth Statement views", () => {
  assert.deepEqual(navigation.WEALTH_SECTION_IDS, [
    "wealth_assets",
    "wealth_reconciliation",
  ]);
  for (const id of navigation.WEALTH_SECTION_IDS)
    assert.ok(
      !navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must not block the income tour`,
    );
  // Every section the live dry-run actually captured is still planned.
  for (const id of [
    "salary",
    "tax_deductions",
    "allowance_credits",
    "withholding",
    "computations",
  ])
    assert.ok(
      navigation.INCOME_SECTION_IDS.includes(id),
      `${id} must stay in the tour`,
    );
  // The plan must remain a valid subset in the original order, salary first.
  assert.equal(navigation.INCOME_SECTION_IDS[0], "salary");
  assert.deepEqual(
    navigation.INCOME_SECTION_IDS,
    navigation.ALL_SECTION_IDS.filter(
      (id) => !navigation.WEALTH_SECTION_IDS.includes(id),
    ),
  );
});

test("Phase 1.6: the agent requests the income plan, not the wealth-blocked one", () => {
  const source = functionSource("runLocalIrisNavigationCheck");
  assert.ok(
    source.includes("sectionIds: irisNavigation.INCOME_SECTION_IDS"),
    "navigation check must request the income section plan",
  );
  assert.ok(
    !source.includes("sectionIds: irisNavigation.ALL_SECTION_IDS"),
    "the wealth-blocked plan must no longer be requested",
  );
});

test("Phase 1.6: a completed section tour is not reported as paused", async () => {
  // portal_sections_inspected is success. While it was returned as paused, both
  // filing flows short-circuited on `navigation?.paused` and autofill could
  // never run, no matter what TAXROCKET_REAL_AUTOFILL was set to.
  const statuses = [];
  const ctx = sandbox(["runLocalIrisNavigationCheck"], {
    assertNavigatorBuild: () => {},
    AGENT_BUILD_TAG: "test-build",
    lastTourStateKey: null,
    lastNavigationOptions: {},
    ensureWorkerWindow: async () => ({ isDestroyed: () => false }),
    getLivePortalWindow: () => ({}),
    navigationStates: new Map(),
    irisNavigation: {
      ...navigation,
      inspectNavigation: async () => ({
        inspection: { frames: [{ document: { present: true } }] },
        requiredAction: "portal_sections_inspected",
      }),
    },
    writePortalInspectionToDisk: () => "C:/logs/inspection.json",
    getSelectorBundleSignal: () => null,
    ensureNavigationJobActive: async () => {},
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    pushStatus: () => {},
    launchState: { accountReference: "1234567890123" },
    realPortalMode: true,
    activeJobExecutionLog: null,
    buildNewReturnContext: () => ({}),
    captureWindowScreenshot: async () => null,
  });
  const outcome = await ctx.runLocalIrisNavigationCheck(
    { filingPacket: { taxYear: 2026, snapshot: {} }, taxAutomationConfig: {} },
    { id: "job-1" },
  );
  assert.equal(
    outcome.paused,
    false,
    "a completed tour must not block autofill",
  );
  assert.equal(outcome.pauseAction, "portal_sections_inspected");
  assert.equal(outcome.result.navigationVerified, true);
  assert.equal(outcome.result.sectionTourComplete, true);
  assert.equal(outcome.result.submitted, false);
  assert.ok(
    !statuses.includes("awaiting_user_action"),
    "a completed tour must not be recorded as awaiting the user",
  );
});

test("Phase 1.6: with autofill off, a completed tour still parks the job for review", async () => {
  // Navigation succeeded but nothing was filled, so the job is finished work
  // awaiting the user — it must not be left silently running or marked done.
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "off",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: {},
      executionLog: [],
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run while the flag is off");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.deepEqual(statuses, ["awaiting_user_action"]);
});

test("Phase 1.6: with dry-run on, a completed tour hands off to autofill", async () => {
  let mode = null;
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: false,
      pauseAction: "portal_sections_inspected",
      pauseMessage: "done",
      result: { navigationVerified: true },
      executionLog: [{ step: "nav" }],
    }),
    runRealIrisAutofill: async (_c, _j, m) => {
      mode = m;
      return {
        executionLog: [{ step: "fill" }],
        result: { mode: m, summary: { filled: 3 } },
      };
    },
    updateLocalJobStatus: async () => {},
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(mode, "dry", "autofill must receive the dry-run mode");
  assert.equal(outcome.paused, false);
  assert.equal(outcome.executionLog.map((s) => s.step).join(","), "nav,fill");
  assert.equal(outcome.result.autofill.summary.filled, 3);
});

test("Phase 1.6: a genuine checkpoint still pauses and is still recorded", async () => {
  const statuses = [];
  const ctx = sandbox(["runLocalTaxDryRunFlow", "finishNavigationOnly"], {
    realPortalMode: true,
    getRealAutofillMode: () => "dry",
    runLocalIrisNavigationCheck: async () => ({
      paused: true,
      pauseAction: "portal_section_navigation",
    }),
    runRealIrisAutofill: () => {
      throw new Error("Autofill must not run behind a pause");
    },
    updateLocalJobStatus: async (_id, status) => statuses.push(status),
    ensureWorkerWindow: () => {
      throw new Error("Legacy filler must not run");
    },
  });
  const outcome = await ctx.runLocalTaxDryRunFlow({ job: { id: "job-1" } });
  assert.equal(outcome.paused, true);
  assert.equal(outcome.pauseAction, "portal_section_navigation");
  // finishNavigationOnly must not re-record an already-paused checkpoint.
  assert.deepEqual(statuses, []);
});

// ─── Phase 2a: fill the section that owns each code ─────────────────────────
// Dry-run 2026-09-09 filled 0/27. The tour ends on Attachment (no data rows)
// and the filler only sees the section on screen, so codes that genuinely exist
// and are editable on Salary were reported row_not_found.

const tourFixture = {
  complete: true,
  sections: [
    {
      id: "salary",
      rows: [{ code: "1000" }, { code: "1009" }, { code: "1049" }],
    },
    { id: "withholding", rows: [{ code: "640000" }, { code: "64150002" }] },
    { id: "computations", rows: [{ code: "9201" }] },
    { id: "attachment", rows: [] },
  ],
};

test("Phase 2a: codes are grouped by the section that actually showed them", () => {
  const index = navigation.buildSectionCodeIndex(tourFixture);
  assert.equal(index.get("1000"), "salary");
  assert.equal(index.get("64150002"), "withholding");
  assert.equal(index.get("9201"), "computations");
  assert.equal(
    index.get("999999"),
    undefined,
    "an unseen code must not resolve",
  );

  const { groups, unlocated } = navigation.planSectionFills(
    [
      { irisCode: "9201" },
      { irisCode: "1000" },
      { irisCode: "640000" },
      { irisCode: "1009" },
      { irisCode: "999999" },
    ],
    tourFixture,
  );
  // Tour order, not packet order: navigation moves forward through the return.
  assert.equal(
    groups.map((g) => g.sectionId).join(","),
    "salary,withholding,computations",
  );
  assert.equal(groups[0].fields.map((f) => f.irisCode).join(","), "1000,1009");
  assert.equal(unlocated.map((f) => f.irisCode).join(","), "999999");
});

test("Phase 2a: an unseen code is never guessed into a section", () => {
  const { groups, unlocated } = navigation.planSectionFills(
    [{ irisCode: "5028" }, { irisCode: "" }, {}],
    tourFixture,
  );
  assert.equal(groups.length, 0);
  assert.equal(
    unlocated.length,
    3,
    "every unresolvable field must be reported, not dropped",
  );
});

test("Phase 2a: an empty or missing tour yields no targets rather than a wrong one", () => {
  for (const tour of [null, undefined, {}, { sections: [] }]) {
    const { groups, unlocated } = navigation.planSectionFills(
      [{ irisCode: "1000" }],
      tour,
    );
    assert.equal(groups.length, 0);
    assert.equal(unlocated.length, 1);
  }
});

test("Phase 2a: navigateToSection refuses an unknown section and never clicks", async () => {
  const result = await navigation.navigateToSection(
    {},
    { sectionId: "not_a_section" },
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "unsupported_section");
});

test("Phase 2a: navigateToSection reports rather than filling the showing grid", async () => {
  await withPage(dashboard(), async (_page, win) => {
    // No return document is open, so there is nothing to switch.
    const result = await navigation.navigateToSection(win, {
      sectionId: "salary",
      taxYear: 2026,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, "document_not_open");
  });
});

test("Phase 2a: autofill walks each owning section and never fills the last-viewed grid", async () => {
  const visited = [];
  const filled = [];
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({ isDestroyed: () => false }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: navigation,
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      fillIrisRows: async (_win, fields) => {
        filled.push(fields.map((f) => f.irisCode).join(","));
        return {
          results: fields.map((f) => ({ ...f, status: "filled" })),
          summary: {},
        };
      },
    },
  });
  // navigateToSection is on the real module; stub only the movement.
  ctx.irisNavigation = {
    ...navigation,
    navigateToSection: async (_win, { sectionId }) => {
      visited.push(sectionId);
      return { ok: true, status: "switched" };
    },
  };
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: {
          portalFieldMap: [
            { irisCode: "9201", label: "c" },
            { irisCode: "1000", label: "a" },
            { irisCode: "1009", label: "b" },
            { irisCode: "5028", label: "unseen" },
          ],
        },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(
    visited.join(","),
    "salary,computations",
    "sections visited in tour order",
  );
  assert.equal(filled.join(" | "), "1000,1009 | 9201");
  // The unseen code is reported, never filled into whatever grid was showing.
  const unseen = outcome.result.results.find((r) => r.irisCode === "5028");
  assert.equal(unseen.status, "row_not_found");
  assert.equal(unseen.sectionId, null);
  assert.equal(
    outcome.result.results.length,
    4,
    "every packet field is accounted for",
  );
});

test("Phase 2a: a section that will not open leaves its fields untouched", async () => {
  const ctx = sandbox(["runRealIrisAutofill"], {
    ensureWorkerWindow: async () => ({ isDestroyed: () => false }),
    launchState: { accountReference: "1234567890123" },
    activeJobExecutionLog: null,
    pushStatus: () => {},
    captureWindowScreenshot: async () => null,
    lastSectionTour: tourFixture,
    irisNavigation: {
      ...navigation,
      navigateToSection: async () => ({ ok: false, status: "tab_not_found" }),
    },
    irisRowFiller: {
      FILL_STATUS: { FILLED: "filled", ROW_NOT_FOUND: "row_not_found" },
      summarise: (results) => ({
        total: results.length,
        filled: 0,
        skipped: results.length,
      }),
      describeFillSummary: () => "summary",
      fillIrisRows: async () => {
        throw new Error("must not fill a section that did not open");
      },
    },
  });
  const outcome = await ctx.runRealIrisAutofill(
    {
      filingPacket: {
        taxYear: 2026,
        snapshot: { portalFieldMap: [{ irisCode: "1000" }] },
      },
    },
    { id: "job-1" },
    "dry",
  );
  assert.equal(outcome.result.results[0].status, "row_not_found");
  assert.equal(outcome.result.results[0].sectionStatus, "tab_not_found");
});

test("Phase 2a: navigateToSection unlocks the navigation allowlist (openReturn)", async () => {
  // Dry-run 2026-09-09 #4: every section click returned
  // "data_tab_navigation_not_enabled" because navigateToSection probed without
  // openReturn, and portalProbe gates the whole navigation action allowlist on
  // it. The plan was correct; the clicks were refused before they were tried.
  const seen = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      getURL: () => "https://iris.fbr.gov.pk/nitr/workflow",
      executeJavaScript: async (source) => {
        const options = JSON.parse(
          source.slice(source.lastIndexOf("})(") + 3, -1),
        );
        seen.push(options);
        return {
          document: { present: true },
          section: { id: "attachment", dataViewActive: false, navigation: [] },
          actionResult: {
            action: options.action || "inspect",
            status: "read_only",
          },
        };
      },
    },
  };
  fakeWindow.webContents.mainFrame = {
    url: "https://iris.fbr.gov.pk/nitr/workflow",
    executeJavaScript: fakeWindow.webContents.executeJavaScript,
  };
  fakeWindow.webContents.mainFrame.framesInSubtree = [
    fakeWindow.webContents.mainFrame,
  ];

  await navigation.navigateToSection(fakeWindow, {
    sectionId: "salary",
    taxYear: 2026,
  });
  assert.ok(seen.length > 0, "the section switch must actually probe the page");
  for (const options of seen)
    assert.equal(
      options.openReturn,
      true,
      "every probe must carry openReturn or portalProbe refuses the click",
    );
});
