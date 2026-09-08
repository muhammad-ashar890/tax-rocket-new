const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));

// Run actual TS modules with mocked auth/database/HTTP only. No database,
// real user session, FBR session or external network is needed.
function moduleLoader(mocks = {}, env = {}) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === "next/server") return { NextResponse: { json: (data, options = {}) => ({ data, status: options.status || 200 }) } };
    const absolute = name.startsWith("@/") ? path.join(root, name.slice(2)) :
      name.startsWith(".") ? path.resolve(parent, name) : path.isAbsolute(name) ? name : null;
    if (!absolute) return require(name);
    const file = fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? absolute : `${absolute}.ts`;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const context = vm.createContext({
      console, process: { env }, URL, URLSearchParams, Date, Buffer,
      exports: module.exports, module,
      require: (child) => load(child, path.dirname(file)),
    });
    vm.runInContext(output, context, { filename: file });
    return module.exports;
  }
  return (name) => load(path.join(root, name));
}

const detailedMap = { incomeFields: [{ irisCode: "1000", column: "Amount Subject to Normal Tax", ourAmount: 1234 }], adjustableTaxFields: [], wealthFields: [] };
function contextHarness({ mock = false, routeFamily, packetAvailable = true, payloadOverride } = {}) {
  const calls = {};
  const payload = { packetId: "packet-4", packetVersion: 4, packetHash: "approved-hash", taxYear: 2026, ...payloadOverride };
  const job = { id: "job-1", status: "offered_to_device", filingDraftId: "draft-1", jobType: "tax_assisted_filing", payloadJson: JSON.stringify(payload), filingDraft: { taxYear: 2026 } };
  const packet = { id: "packet-4", version: 4, packetHash: "approved-hash", snapshotJson: JSON.stringify({
    filing: { taxYear: 2026, filerType: "myself" }, routeMetadata: routeFamily ? { routeFamily, routeLabel: "Approved form" } : undefined,
    returnSummary: { taxPayable: 123 }, portalFieldMap: detailedMap,
  }) };
  const prisma = {
    trustedDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", status: "ACTIVE" }) },
    localAgentJob: { findFirst: async () => job, update: async () => job },
    filingPacket: { findFirst: async (args) => { calls.packetQuery = args; return packetAvailable ? packet : null; } },
    taxAuditEvent: { create: async () => ({}) },
  };
  const load = moduleLoader({ "@/lib/prisma": { prisma } }, { FBR_USE_MOCK_IRIS: String(mock) });
  const route = load("app/api/local-agent/jobs/[jobId]/context/route.ts");
  return { calls, run: () => route.GET({ url: "https://app.invalid/api/context", headers: new Headers({ authorization: "Bearer synthetic-token" }) }, { params: Promise.resolve({ jobId: "job-1" }) }) };
}

test("real context pins approved packet and preserves detailed map, route and tax year", async () => {
  const harness = contextHarness({ routeFamily: "normal_individual_114" });
  const response = await harness.run();
  assert.equal(response.status, 200);
  assert.equal(harness.calls.packetQuery.where.id, "packet-4");
  assert.equal(harness.calls.packetQuery.where.version, 4);
  assert.equal(harness.calls.packetQuery.where.packetHash, "approved-hash");
  assert.equal(harness.calls.packetQuery.where.approvalStatus, "APPROVED");
  assert.equal(harness.calls.packetQuery.orderBy, undefined);
  assert.equal(response.data.filingPacket.taxYear, 2026);
  assert.equal(response.data.filingPacket.packetVersion, 4);
  assert.equal(response.data.snapshot.routeMetadata.routeFamily, "normal_individual_114");
  assert.equal(response.data.snapshot.returnSummary.taxPayable, 123);
  assert.ok(response.data.taxAutomationConfig.routeSelector);
  assert.deepEqual(plain(response.data.snapshot.portalFieldMap), detailedMap);
  assert.equal(JSON.stringify(response.data.snapshot.portalFieldMap).includes("data-tax-field-key"), false);
  assert.equal(response.data.taxAutomationConfig.livePilot.automaticFilingEnabled, false);
});

test("unknown form is an explicit identification checkpoint, not an assumed normal return", async () => {
  const response = await contextHarness().run();
  assert.equal(response.data.snapshot.routeMetadata.routeFamily, null);
  assert.equal(response.data.snapshot.routeMetadata.requiresIdentification, true);
  assert.equal(response.data.taxAutomationConfig.routeSelector, null);
  assert.equal(response.data.taxAutomationConfig.livePilot.mode, "navigation_inspection_only");
});

test("mock context alone receives fixture selectors", async () => {
  const response = await contextHarness({ mock: true }).run();
  assert.equal(Array.isArray(response.data.snapshot.portalFieldMap), true);
  assert.equal(response.data.snapshot.portalFieldMap[0].selector, '[data-tax-field-key="return.tax_year"]');
  assert.equal(response.data.taxAutomationConfig.readiness.loginUrl, "mock-iris://login");
});

test("missing or superseded queued packet cannot silently become latest packet", async () => {
  assert.equal((await contextHarness({ packetAvailable: false }).run()).status, 404);
  const missing = contextHarness({ payloadOverride: { packetId: null } });
  assert.equal((await missing.run()).status, 409);
  assert.equal(missing.calls.packetQuery, undefined);
});

test("desktop handoff and job use the SAME real/mock authentication configuration", () => {
  for (const mock of [false, true]) {
    const load = moduleLoader({}, { FBR_USE_MOCK_IRIS: String(mock), NEXTAUTH_URL: "http://localhost:3000" });
    const desktop = load("lib/tax/fbr-desktop.ts");
    const auth = load("lib/tax/fbr-agent-config.ts").getFbrDesktopAuthConfig();
    const session = desktop.buildDesktopSessionConfig({ launchToken: "test-launch", partitionKey: "test-partition", deviceTokenHash: "test-hash" });
    const url = new URL(session.deepLink);
    assert.equal(url.searchParams.get("loginUrl"), auth.loginUrl);
    assert.equal(url.searchParams.get("useMockIris"), String(mock));
    assert.equal(session.irisReadySelector, auth.readySelector);
    assert.equal(session.localhostUrl, "http://127.0.0.1:37219/connect");
    assert.equal(desktop.generatePartitionKey("user-one"), desktop.generatePartitionKey("user-one"));
    assert.notEqual(desktop.generatePartitionKey("user-one"), desktop.generatePartitionKey("user-two"));
  }
  const load = moduleLoader({}, { FBR_USE_MOCK_IRIS: "true", FBR_IRIS_LOGIN_URL: "https://iris.fbr.gov.pk/" });
  assert.throws(() => load("lib/tax/fbr-agent-config.ts").getFbrDesktopAuthConfig(), /disagree/);
});

function statusHarness({ status = "running", raceClosed = false } = {}) {
  const calls = {};
  let job = { id: "job-1", status, userId: "user-1", trustedDeviceId: "device-1", filingDraftId: "draft-1", jobType: "tax_assisted_filing", startedAt: new Date() };
  const prisma = {
    trustedDevice: { findUnique: async () => ({ id: "device-1", userId: "user-1", status: "ACTIVE" }), update: async () => ({}) },
    localAgentJob: {
      findFirst: async () => job,
      updateMany: async (args) => { calls.update = args; job = { ...job, ...args.data }; return { count: raceClosed ? 0 : 1 }; },
      findUniqueOrThrow: async () => job,
    },
    taxAuditEvent: { create: async () => ({}) }, fbrConnection: { updateMany: async () => ({ count: 1 }) },
  };
  const load = moduleLoader({ "@/lib/prisma": { prisma } });
  const route = load("app/api/local-agent/jobs/[jobId]/status/route.ts");
  const run = (body) => route.POST({ json: async () => body, headers: new Headers({ authorization: "Bearer test" }) }, { params: Promise.resolve({ jobId: "job-1" }) });
  return { calls, run };
}

test("status endpoint accepts executionLog/errorMessage aliases actually sent by Electron", async () => {
  const harness = statusHarness();
  const logs = [{ step: "draft_inventory", detail: "Synthetic test" }];
  const response = await harness.run({ status: "awaiting_user_action", executionLog: logs, errorMessage: "test-error", result: { requiredAction: "portal_inspection", pauseReason: "Identify form" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(harness.calls.update.data.logsJson), logs);
  assert.equal(harness.calls.update.data.errorMessage, "test-error");
  assert.equal(harness.calls.update.data.pauseAction, "portal_inspection");
});

test("late reports and cancellation races cannot resurrect a terminal job", async () => {
  const closed = statusHarness({ status: "cancelled" });
  assert.equal((await closed.run({ status: "running" })).status, 409);
  assert.equal(closed.calls.update, undefined);
  const race = statusHarness({ raceClosed: true });
  assert.equal((await race.run({ status: "awaiting_user_action" })).status, 409);
  assert.ok(race.calls.update.where.status.notIn.includes("cancelled"));
});

test("recovery actions retry the SAME phase; unknown actions never skip filling", () => {
  const next = moduleLoader()("lib/tax/fbr-job-resume.ts").getNextFbrPilotPhase;
  for (const action of ["selector_bundle_update", "session_reconnect", "portal_popup", "portal_inspection", "unknown", ""]) {
    assert.equal(next(action, "start"), "start");
    assert.equal(next(action, "after_password_reset"), "after_password_reset");
  }
  assert.equal(next("password_reset", "start"), "after_password_reset");
  assert.equal(next("classic_final_review", "start"), "after_otp_captcha_pin");
  assert.equal(next("classic_pin_entry", "after_otp_captcha_pin"), "after_classic_pin_entry");
});

test("server final-submit gate still rejects a generic Continue action", async () => {
  let updated = false;
  const prisma = {
    user: { findUnique: async () => ({ id: "user-1" }) },
    localAgentJob: {
      findFirst: async () => ({ id: "job-1", userId: "user-1", status: "awaiting_user_action", pauseAction: "final_submit_confirmation", resultJson: "{}", payloadJson: '{"livePilotState":{"phase":"start"}}' }),
      update: async () => { updated = true; return {}; },
    },
  };
  const load = moduleLoader({
    "@/lib/prisma": { prisma }, "next-auth/next": { getServerSession: async () => ({ user: { email: "test@example.invalid" } }) },
    "@/lib/auth": { authOptions: {} }, "@/app/actions/notifications": { createNotification: async () => {} },
  });
  const actions = load("app/actions/fbr-jobs.ts");
  const result = await actions.resumeJobAfterPauseAction("job-1", { confirmedBy: "user" });
  assert.equal(result.success, false);
  assert.equal(updated, false);
});

test("reconnect reuses stable device row but clears previous login readiness", async () => {
  let upsert;
  const prisma = {
    user: { findUnique: async () => ({ id: "user-1" }) },
    filingDraft: { findFirst: async () => ({ id: "draft-1", taxYear: 2026 }) },
    filingPacket: { findFirst: async () => ({ id: "packet-4", version: 4 }) },
    trustedDevice: {
      findUnique: async () => ({ id: "device-1", userId: "user-1", localFbrConnectedAt: new Date() }),
      upsert: async (args) => { upsert = args; return { id: "device-1", partitionKey: args.where.partitionKey, status: "PENDING" }; },
    },
    taxAuditEvent: { create: async () => ({}) },
  };
  const load = moduleLoader({ "@/lib/prisma": { prisma }, "next-auth/next": { getServerSession: async () => ({ user: { email: "test@example.invalid" } }) }, "@/lib/auth": { authOptions: {} } });
  const route = load("app/api/fbr-connect/desktop/session/route.ts");
  const response = await route.POST({ json: async () => ({ filingDraftId: "draft-1" }) });
  assert.equal(response.status, 200);
  assert.equal(upsert.update.localFbrConnectedAt, null);
  assert.equal(upsert.update.status, "PENDING");
  assert.equal(response.data.device.id, "device-1");
});

test("packaged Windows agent includes the new module and frontend uses one transport", () => {
  const agentPackage = JSON.parse(fs.readFileSync(path.join(root, "electron-connect/package.json"), "utf8"));
  assert.ok(agentPackage.build.files.includes("iris-navigation.js"));
  const ui = fs.readFileSync(path.join(root, "components/tax/fbr-connect-client.tsx"), "utf8");
  assert.ok(!ui.includes("fetch(data.session.localhostUrl"));
  assert.ok(ui.includes("const agentReady = Boolean(readyDevice)"));
  assert.ok(ui.includes("d.localFbrConnectedAt"));
});
