const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { chromium } = require("playwright");
const navigation = require("../electron-connect/iris-navigation");

let browser;
before(async () => { browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] }); });
after(async () => { await browser?.close(); });

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
  await context.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
  await page.goto("https://iris.fbr.gov.pk/dashboard?token=PRIVATE_URL_TOKEN#PRIVATE_HASH");
  const mainFrame = {
    get url() { return page.url(); },
    executeJavaScript: (source) => page.evaluate(source),
  };
  mainFrame.framesInSubtree = [mainFrame];
  const windowInstance = { isDestroyed: () => false, webContents: { mainFrame, getURL: () => page.url(), executeJavaScript: mainFrame.executeJavaScript } };
  try { await run(page, windowInstance); } finally { await context.close(); }
}

const welcome = `<div class="modal-backdrop" id="backdrop"></div><section role="dialog" id="promo">
<h2>Submit Your Income Tax Return</h2><p>Tax year 2026 — Last Date</p>
<button aria-label="Close" onclick="actions.push('close_welcome');document.querySelector('#backdrop').remove();document.querySelector('#promo').remove()">×</button></section>`;

test("live inspection closes ONLY identified welcome and waits for Angular draft tabs/grid", async () => {
  await withPage(dashboard(welcome), async (page, windowInstance) => {
    const steps = [];
    const result = await navigation.inspectNavigation(windowInstance, { taxYear: 2026, onStep: (step) => steps.push(step) });
    assert.equal(result.requiredAction, "portal_inspection");
    assert.deepEqual(await page.evaluate("actions"), ["close_welcome", "draft", "it"]);
    const frame = result.inspection.frames[0];
    assert.equal(frame.rows.length, 2);
    assert.deepEqual(frame.rows[0].form.codes, ["114(1)"]);
    assert.equal(frame.rows[0].requestedYearMentioned, true);
    assert.equal(frame.rows[1].requestedYearMentioned, false);
    assert.deepEqual(frame.rows[0].candidatePeriods, ["01-Jul-2025", "30-Jun-2026"]);
    assert.ok(steps.includes("draft_inventory"));
    assert.equal(await page.locator("#search").inputValue(), "PRIVATE_SEARCH_VALUE");
    const exported = JSON.stringify(result);
    for (const secret of ["PRIVATE TEST", "PRIVATE_SEARCH_VALUE", "PRIVATE_STORAGE_TOKEN", "PRIVATE_URL_TOKEN", "PRIVATE_HASH"]) {
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
    const result = await navigation.probeFrames(win, { action: "close-welcome" });
    assert.equal(result.frames[0].actionResult.status, "manual_close_required");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("reappearing welcome popup retries are bounded and never navigate behind it", async () => {
  const recurring = welcome.replace("document.querySelector('#promo').remove()", "document.querySelector('#promo').remove();setTimeout(()=>document.body.insertAdjacentHTML('beforeend',window.recurringMarkup),100)");
  await withPage(dashboard(recurring), async (page, win) => {
    await page.evaluate(() => { window.recurringMarkup = document.querySelector('#backdrop').outerHTML + document.querySelector('#promo').outerHTML; });
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "portal_popup");
    assert.deepEqual(await page.evaluate("actions"), Array(4).fill("close_welcome"));
    assert.equal(await page.evaluate("Boolean(window.__taxrocketPopupGuardTimer)"), false);
  });
});

test("body/domain/search input do not prove login or return readiness", async () => {
  await withPage(`<body><input type="password" name="password" value="PRIVATE_PASSWORD"><button>Login</button></body>`, async (page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "session_reconnect");
    assert.equal(navigation.isAuthenticated(result.inspection), false);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_PASSWORD"));
  });
  await withPage(`<body><input id="search"></body>`, async (_page, win) => {
    const result = await navigation.inspectNavigation(win, { taxYear: 2026 });
    assert.equal(result.requiredAction, "session_reconnect");
  });
});

test("duplicate navbar ids are resolved by exact semantic action, never first id match", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, { action: "declaration-menu" });
    assert.equal(result.frames[0].actionResult.status, "clicked");
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
    await page.evaluate(() => {
      const extra = document.querySelector('#navbarDropdown1').cloneNode(true);
      extra.textContent = "Declaration";
      document.querySelector('nav').appendChild(extra);
      window.actions = [];
    });
    const ambiguous = await navigation.probeFrames(win, { action: "declaration-menu" });
    assert.equal(ambiguous.frames[0].actionResult.status, "ambiguous");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

test("only approved HTTPS hosts and actual Electron child-frame API are inspected", async () => {
  assert.equal(navigation.isAllowedPortalUrl("https://iris.fbr.gov.pk/dashboard"), true);
  for (const url of ["https://iris.fbr.gov.pk.evil.example", "http://iris.fbr.gov.pk", "https://evil.example/?iris.fbr.gov.pk", "file:///mock.html"]) {
    assert.equal(navigation.isAllowedPortalUrl(url), false);
  }
  const called = [];
  const main = { url: "https://iris.fbr.gov.pk/dashboard", executeJavaScript: async () => { called.push("main"); return { authenticated: true }; } };
  const child = { url: "https://iris.fbr.gov.pk/return", executeJavaScript: async () => { called.push("child"); return {}; } };
  const external = { url: "https://help.example", executeJavaScript: async () => { throw new Error("MUST NOT READ"); } };
  main.framesInSubtree = [main, child, external];
  const result = await navigation.probeFrames({ isDestroyed: () => false, webContents: { mainFrame: main } });
  assert.deepEqual(called, ["main", "child"]);
  assert.equal(result.frames[2].skipped, "unapproved_origin");
  assert.deepEqual(await navigation.probeFrames(null), { frames: [], unavailable: "window_closed" });
});

test("read-only action whitelist cannot be used to submit or click arbitrary selectors", async () => {
  await withPage(dashboard(), async (page, win) => {
    const result = await navigation.probeFrames(win, { action: "submit", selector: "button" });
    assert.equal(result.frames[0].actionResult.status, "unsupported_action");
    assert.deepEqual(await page.evaluate("actions"), []);
  });
});

const mainSource = fs.readFileSync(path.join(__dirname, "../electron-connect/main.js"), "utf8");
const ast = ts.createSourceFile("main.js", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  const found = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, `Function ${name} exists`);
  return found.getText(ast);
}
function sandbox(names, extras = {}) {
  const ctx = vm.createContext({ console, Promise, Date, setTimeout, clearTimeout, ...extras });
  for (const name of names) vm.runInContext(functionSource(name), ctx);
  return ctx;
}

test("main worker is single-flight even while the claim request is still pending", async () => {
  let release;
  let calls = 0;
  const ctx = sandbox(["runLocalWorkerCycle"], {
    localWorkerRunning: false, workerIdleAnnounced: false,
    launchState: { deviceAuthToken: "test-token" }, getApiBaseUrl: () => "https://test.invalid",
    loadAgentState: () => ({}), pushStatus: () => {},
    claimNextLocalJob: () => { calls++; return new Promise((resolve) => { release = resolve; }); },
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
  const win = { isDestroyed: () => false, taxRocketPartition: "persist:test",
    webContents: { getURL: () => "https://iris.fbr.gov.pk/dashboard" },
    loadURL: async () => calls.push("load"), show: () => {}, focus: () => {},
    setTitle: () => {}, close: () => calls.push("close") };
  const ctx = sandbox(["createLoginWindow", "ensureWorkerWindow"], {
    loginWindowPromise: null, loginWindow: win, workerWindow: null,
    realPortalMode: true, AGENT_BUILD_TAG: "test", irisNavigation: navigation,
    launchState: { flow: "fbr", token: "test", apiBaseUrl: "https://test.invalid", deviceAuthToken: "registered", desktopAuthConfig: { useMockIris: false } },
    getWorkerPartition: () => "persist:test", resolveDesktopLoginUrl: () => "https://iris.fbr.gov.pk/",
    scheduleAutoCapture: () => {}, startLocalWorkerLoop: () => {},
  });
  assert.equal(await ctx.createLoginWindow(true), win);
  assert.equal(await ctx.ensureWorkerWindow(), win);
  assert.deepEqual(calls, []);
});

test("real assisted AND dry-run dispatch to inspection before any legacy fill/submit code", async () => {
  let called = 0;
  const ctx = sandbox(["runLocalTaxAssistedFilingFlow", "runLocalTaxDryRunFlow"], {
    realPortalMode: true,
    runLocalIrisNavigationCheck: async () => { called++; return { paused: true }; },
    ensureWorkerWindow: () => { throw new Error("Legacy filler must not run"); },
  });
  assert.equal((await ctx.runLocalTaxAssistedFilingFlow({}, {})).paused, true);
  assert.equal((await ctx.runLocalTaxDryRunFlow({ job: {} })).paused, true);
  assert.equal(called, 2);
});

test("CSS timeout does not starve a valid text navigation fallback", async () => {
  await withPage(dashboard(), async (page, win) => {
    const ctx = sandbox(["splitSelectorAlternatives", "findAndClickByText", "clickSelectorWithTextSupport"]);
    await ctx.clickSelectorWithTextSupport(win, "#absent-selector, text:Declaration", 500);
    assert.deepEqual(await page.evaluate("actions"), ["declaration"]);
  });
});

test("legacy menu helper clicks the successfully resolved selector", async () => {
  for (const [fn, key] of [["navigateIrisTopMenu", "topMenuSelector"], ["navigateIrisLeftCategory", "leftCategorySelector"]]) {
    const clicks = [];
    const ctx = sandbox([fn], {
      setTimeout: (callback) => { callback(); },
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
    loadLocalJobContext: async () => { throw new Error("Queued approved packet unavailable"); },
    saveFailureDump: async () => null, captureDomEvidence: async () => ({ frames: [] }),
    workerWindow: null, activeJobExecutionLog: null,
    STANDARD_LOG_STEPS: { FAILURE: "failure" },
    classifyRecoverableAssistedIssue: () => null,
    buildSelectorDriftDiagnostics: () => null, getSelectorBundleSignal: () => null,
    buildRecoveryActions: () => [],
    updateLocalJobStatus: async (_id, status) => calls.push(status),
    writeJobLogToDisk: async () => { calls.push("log"); return null; },
    cleanupJobDocuments: async () => calls.push("cleanup"), pushStatus: () => {},
  });
  await ctx.processLocalJob({ id: "job-test", type: "tax_assisted_filing", status: "created" });
  assert.deepEqual(calls, ["failed", "log", "cleanup"]);
});
