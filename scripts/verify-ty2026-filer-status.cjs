const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const originalTsLoader = Module._extensions[".ts"];
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};

let assertionCount = 0;
function equal(actual, expected, label) {
  assertionCount += 1;
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}
function includes(source, fragment, label) {
  assertionCount += 1;
  if (!source.includes(fragment))
    throw new Error(`${label}: missing ${fragment}`);
}
function matches(source, pattern, label) {
  assertionCount += 1;
  if (!pattern.test(source))
    throw new Error(`${label}: source pattern not found`);
}

try {
  const { calculateTaxEstimate } = require(
    path.join(root, "lib", "tax", "tax-calculation.ts"),
  );
  const { parseManualTaxpayerListStatus } = require(
    path.join(root, "lib", "tax", "tax-data-model.ts"),
  );

  const commonBankInput = {
    taxYear: 2026,
    totalIncome: 100_000,
    totalExpenses: 0,
    bankProfitIncome: 100_000,
    taxWithheld: 0,
    isSalariedRoute: false,
    isPensionRoute: false,
    isRentalRoute: false,
    isBankProfitRoute: true,
    // Section 151 holds six rows from 10% to 25%, so the row must be named.
    incomeSources: [
      {
        route: "bank_profit",
        income: 100_000,
        subcategory: "bank-or-financial-institution-deposit",
      },
    ],
  };
  const atlBank = calculateTaxEstimate({
    ...commonBankInput,
    filerStatus: "ATL",
  });
  const nonAtlBank = calculateTaxEstimate({
    ...commonBankInput,
    filerStatus: "NON_ATL",
  });
  equal(atlBank.taxDue, 20_000, "ATL bank-profit estimate");
  equal(nonAtlBank.taxDue, 40_000, "Non-ATL bank-profit estimate");
  equal(atlBank.filerStatus, "ATL", "ATL result status");
  equal(nonAtlBank.filerStatus, "NON_ATL", "Non-ATL result status");

  const commonSalaryInput = {
    taxYear: 2026,
    totalIncome: 1_800_000,
    totalExpenses: 0,
    bankProfitIncome: 0,
    taxWithheld: 0,
    isSalariedRoute: true,
    isPensionRoute: false,
    isRentalRoute: false,
    isBankProfitRoute: false,
  };
  equal(
    calculateTaxEstimate({ ...commonSalaryInput, filerStatus: "ATL" }).taxDue,
    72_000,
    "ATL salary estimate",
  );
  equal(
    calculateTaxEstimate({ ...commonSalaryInput, filerStatus: "NON_ATL" })
      .taxDue,
    72_000,
    "Salary default rate for Non-ATL selection",
  );

  equal(parseManualTaxpayerListStatus("ATL"), "ATL", "Manual ATL parser");
  equal(
    parseManualTaxpayerListStatus("NON_ATL"),
    "NON_ATL",
    "Manual Non-ATL parser",
  );
  equal(
    parseManualTaxpayerListStatus("LATE_FILER"),
    null,
    "Manual Late Filer rejection",
  );
  equal(
    parseManualTaxpayerListStatus("invalid"),
    null,
    "Invalid status rejection",
  );

  const ui = fs.readFileSync(
    path.join(root, "components", "tax", "filing", "wizard-review-step.tsx"),
    "utf8",
  );
  includes(ui, "Calculate for ATL", "ATL button");
  includes(ui, "Calculate for Non-ATL", "Non-ATL button");
  includes(ui, "Calculated for", "Selected-status result badge");

  const wizard = fs.readFileSync(
    path.join(root, "components", "tax", "filing", "filing-wizard.tsx"),
    "utf8",
  );
  matches(
    wizard,
    /key === "approval"[\s\S]{0,80}\? approvalConfirmed/,
    "Approval rail uses current approval state",
  );
  matches(
    wizard,
    /key === "filing_packet"[\s\S]{0,80}\? Boolean\(filingPacket\)/,
    "Packet rail uses current packet state",
  );
  matches(
    wizard,
    /key === "fbr_connect"[\s\S]{0,80}\? fbrConnectionStatus === "COMPLETED"/,
    "FBR rail uses current connection state",
  );
  includes(
    wizard,
    'setFbrConnectionStatus("NOT_STARTED")',
    "FBR rail invalidation",
  );

  const action = fs.readFileSync(
    path.join(root, "app", "actions", "tax-calculation.ts"),
    "utf8",
  );
  for (const fragment of [
    "parseManualTaxpayerListStatus",
    "taxpayerListStatus: filerStatus",
    'taxpayerListStatusSource: "MANUAL"',
    "taxRuleSetVersion: TY2026_RULE_SET_VERSION",
    "taxCalculationRevision: calculationRevision",
    'status: "SUPERSEDED"',
    'status: "NOT_STARTED"',
  ]) {
    includes(action, fragment, "Tax calculation action");
  }

  const summary = fs.readFileSync(
    path.join(root, "app", "actions", "filing-summary.ts"),
    "utf8",
  );
  includes(summary, "taxpayerListStatus", "Filing summary status hydration");

  const packet = fs.readFileSync(
    path.join(root, "app", "actions", "packet.ts"),
    "utf8",
  );
  includes(
    packet,
    "Calculate a current ATL or Non-ATL tax estimate first",
    "Packet gate",
  );
  includes(packet, "Taxpayer-list status:", "Packet PDF status");

  console.log("TY2026 manual filer-status flow is valid.");
  console.log(
    JSON.stringify(
      {
        calculationScenarios: 4,
        assertionCount,
        buttons: ["ATL", "NON_ATL"],
        statusSource: "MANUAL",
        stalePacketInvalidation: true,
        stateAwareRailCompletion: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
  else delete Module._extensions[".ts"];
}
