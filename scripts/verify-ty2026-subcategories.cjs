const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");

// Repo modules import each other with the "@/" alias that tsconfig maps to
// the project root. Node knows nothing about that mapping, so it is resolved
// here -- otherwise pulling in any file that uses the alias fails outright.
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) {
    request = path.join(root, request.slice(2));
  }
  return originalResolveFilename.call(this, request, ...rest);
};

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
function ok(value, label) {
  assertionCount += 1;
  if (!value) throw new Error(`${label}: expected truthy value`);
}
function includes(source, fragment, label) {
  assertionCount += 1;
  if (!source.includes(fragment))
    throw new Error(`${label}: missing ${fragment}`);
}
function excludes(source, fragment, label) {
  assertionCount += 1;
  if (source.includes(fragment))
    throw new Error(`${label}: unexpected ${fragment}`);
}

try {
  const { TY2026_RATE_CARD_RULES } = require(
    path.join(root, "lib", "tax", "rules", "ty2026", "catalog.ts"),
  );
  const subcategories = require(
    path.join(root, "lib", "tax", "rules", "ty2026", "subcategories.ts"),
  );
  const { getPipelineStartIndex } = require(
    path.join(root, "lib", "tax", "filing-status.ts"),
  );
  const wizardCompletion = require(
    path.join(root, "lib", "tax", "wizard-completion.ts"),
  );

  const expectedOptionCounts = {
    imports: 10,
    salary: 2,
    pension: 3,
    dividend: 8,
    bank_profit: 6,
    capital_gains: 1,
    foreign_income_assets: 19,
    business: 16,
    services: 7,
    property_rent: 2,
    other_income: 5,
    advance_tax: 27,
  };

  const representedRuleIds = new Set();
  let optionCount = 0;
  let deferredOptionCount = 0;
  for (const [source, expectedCount] of Object.entries(expectedOptionCounts)) {
    const options = subcategories.getTy2026SubcategoryOptions(source);
    equal(options.length, expectedCount, `${source} option count`);
    optionCount += options.length;
    for (const option of options) {
      for (const ruleId of option.ruleIds) {
        ok(!representedRuleIds.has(ruleId), `${ruleId} represented once`);
        representedRuleIds.add(ruleId);
      }
      if (option.implementationStatus === "NEEDS_EXTERNAL_DETAIL") {
        deferredOptionCount += 1;
      }
    }
  }

  equal(optionCount, 106, "Unique source/subcategory card count");
  equal(representedRuleIds.size, 152, "All catalog rules represented");
  equal(
    representedRuleIds.size,
    TY2026_RATE_CARD_RULES.length,
    "Catalog and subcategory coverage agree",
  );
  equal(deferredOptionCount, 6, "Deferred client-confirmation card count");
  equal(
    subcategories.TY2026_SUBCATEGORY_STEPS.length,
    10,
    "Catalog-supported step-definition count",
  );
  const wizardStepDefinitions = subcategories.TY2026_SUBCATEGORY_STEPS.filter(
    (step) => !["imports", "advance_tax"].includes(step.source),
  );
  const wizardSelectableCardCount = wizardStepDefinitions.reduce(
    (total, step) =>
      total + subcategories.getTy2026SubcategoryOptions(step.source).length,
    0,
  );
  equal(wizardStepDefinitions.length, 8, "Visible wizard category-step count");
  equal(wizardSelectableCardCount, 66, "Visible wizard subcategory-card count");

  const dynamicSteps = subcategories.getTy2026SubcategoryStepKeys(
    ["salary", "bank_profit", "services"],
    2026,
  );
  equal(
    dynamicSteps.length,
    2,
    "Only sources requiring classification add steps",
  );
  equal(
    dynamicSteps[0],
    "subcategory_services",
    "Canonical services step order",
  );
  equal(
    dynamicSteps[1],
    "subcategory_bank_profit",
    "Canonical bank step order",
  );
  equal(
    subcategories.getTy2026SubcategoryStepKeys(["bank_profit"], 2027).length,
    0,
    "TY2026 steps never leak into TY2027",
  );

  equal(
    wizardCompletion.advanceWizardCompletion(4, 7),
    7,
    "Forward navigation advances completion",
  );
  equal(
    wizardCompletion.shrinkWizardCompletion(11, 4),
    4,
    "Upstream change shrinks completion",
  );
  equal(
    wizardCompletion.shrinkWizardCompletion(4, 9),
    4,
    "Stale downstream reset cannot re-grow completion",
  );
  equal(
    wizardCompletion.clampWizardLocation(11, 4),
    4,
    "Resume cannot open beyond valid completion",
  );
  equal(
    wizardCompletion.isWizardStepCompleted(3, 4),
    true,
    "Step before completion boundary is checked",
  );
  equal(
    wizardCompletion.isWizardStepCompleted(4, 4),
    false,
    "Reset step and downstream steps are unchecked",
  );

  const automaticSalary = subcategories.getTy2026AutomaticIncomeSelections([
    "salary",
  ]);
  equal(
    automaticSalary.length,
    2,
    "Salary and surcharge are derived selections",
  );
  ok(
    automaticSalary.every((selection) =>
      subcategories.isTy2026AutomaticIncomeSelection(selection),
    ),
    "Automatic salary selections marked derived",
  );

  const multiple = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["salary", "bank_profit"],
    selections: [
      {
        source: "bank_profit",
        subcategory: "bank-or-financial-institution-deposit",
      },
      { source: "bank_profit", subcategory: "other-profit-on-debt" },
    ],
  });
  ok(multiple.success, "Multiple subcategories accepted");
  equal(
    multiple.selections.length,
    4,
    "Two manual plus two derived selections",
  );

  const missing = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["bank_profit"],
    selections: [],
  });
  equal(missing.success, false, "Required bank subcategory enforced");
  const incompleteDraft = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["bank_profit"],
    selections: [],
    requireComplete: false,
  });
  ok(
    incompleteDraft.success,
    "Draft navigation allows a future category step to remain incomplete",
  );
  const invalid = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["bank_profit"],
    selections: [{ source: "bank_profit", subcategory: "not-a-rule" }],
  });
  equal(invalid.success, false, "Unknown catalog subcategory rejected");
  const wrongSource = subcategories.resolveTy2026IncomeSelections({
    incomeSources: ["salary"],
    selections: [
      {
        source: "bank_profit",
        subcategory: "bank-or-financial-institution-deposit",
      },
    ],
  });
  equal(wrongSource.success, false, "Unselected source subcategory rejected");

  equal(
    getPipelineStartIndex({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["bank_profit"],
    }),
    7,
    "Individual bank-profit pipeline offset",
  );
  equal(
    getPipelineStartIndex({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["salary", "bank_profit"],
    }),
    8,
    "Mixed salary/bank pipeline offset",
  );
  equal(
    getPipelineStartIndex({
      taxYear: 2026,
      filerType: "my_business",
      businessStructure: "company",
      incomeSources: ["business"],
    }),
    8,
    "Company business pipeline offset",
  );

  const ui = fs.readFileSync(
    path.join(
      root,
      "components",
      "tax",
      "filing",
      "wizard-income-subcategory-step.tsx",
    ),
    "utf8",
  );
  includes(ui, "Select all that apply", "Multi-select UI instruction");
  includes(ui, "needs client", "Deferred-rule UI warning");
  includes(ui, "aria-pressed", "Accessible selectable cards");

  const setupUi = fs.readFileSync(
    path.join(root, "components", "tax", "filing", "wizard-setup-step.tsx"),
    "utf8",
  );
  excludes(
    setupUi,
    'currentStepKey === "tax_activities"',
    "Import/advance-tax wizard step removed",
  );
  excludes(setupUi, 'value: "imports"', "Imports card removed from wizard");
  excludes(
    setupUi,
    'value: "advance_tax"',
    "Advance-tax card removed from wizard",
  );

  const filingWizard = fs.readFileSync(
    path.join(root, "components", "tax", "filing", "filing-wizard.tsx"),
    "utf8",
  );
  includes(
    filingWizard,
    'formData.set("currentStep", String(step))',
    "Current back-navigation position is autosaved",
  );
  includes(
    filingWizard,
    'formData.set("wizardCompletionStep", String(furthestStepReached))',
    "Authoritative completion boundary is autosaved separately",
  );
  includes(
    filingWizard,
    "existing.wizardCompletionStep",
    "Resume hydrates the persisted completion boundary",
  );
  includes(
    filingWizard,
    "wizardCompletionStep: furthestStepReached",
    "Forward saves carry the expected completion boundary",
  );
  excludes(
    filingWizard,
    "Math.max(prev, step)",
    "Current location does not implicitly re-grow completion",
  );
  includes(
    filingWizard,
    "const completed = reachedPreviously && hasRequiredCurrentState",
    "Persisted boundary gates every sidebar checkmark",
  );

  const filingAction = fs.readFileSync(
    path.join(root, "app", "actions", "filing.ts"),
    "utf8",
  );
  includes(filingAction, "replaceIncomeSelections", "Selection persistence");
  includes(filingAction, ': "MANUAL"', "Manual source metadata");
  includes(filingAction, '? "DERIVED"', "Derived source metadata");
  includes(
    filingAction,
    "classificationChanged",
    "Downstream invalidation guard",
  );
  includes(
    filingAction,
    "requireCompleteSubcategories: true",
    "Review/Create strict completeness gate",
  );
  includes(
    filingAction,
    "requireComplete: false",
    "Draft navigation permits incomplete future steps",
  );
  includes(
    filingAction,
    "dataToUpdate.currentStep = formData.currentStep",
    "Current screen remains independently persisted",
  );
  includes(
    filingAction,
    "dataToUpdate.wizardCompletionStep = shrinkWizardCompletion(",
    "Auto-save can only shrink the authoritative completion boundary",
  );
  includes(
    filingAction,
    "wizardCompletionStep: expectedCompletionStep",
    "Forward completion uses compare-and-set race protection",
  );
  includes(
    filingAction,
    "wizardCompletionStep: shrinkWizardCompletion(",
    "Explicit invalidation cannot re-grow a prior upstream reset",
  );

  const schema = fs.readFileSync(
    path.join(root, "prisma", "schema.prisma"),
    "utf8",
  );
  includes(
    schema,
    "wizardCompletionStep Int",
    "Filing draft stores a separate completion boundary",
  );
  const completionMigration = fs.readFileSync(
    path.join(
      root,
      "prisma",
      "migrations",
      "20260818120000_add_wizard_completion_step",
      "migration.sql",
    ),
    "utf8",
  );
  includes(
    completionMigration,
    'ADD COLUMN "wizardCompletionStep"',
    "Additive completion-boundary migration",
  );
  includes(
    completionMigration,
    'SET "wizardCompletionStep" = "currentStep"',
    "Existing drafts preserve their prior progress during migration",
  );

  const newFilingPage = fs.readFileSync(
    path.join(root, "app", "tax", "new", "page.tsx"),
    "utf8",
  );
  includes(
    newFilingPage,
    "wizardCompletionStep:",
    "Resume auto-save forwards the completion boundary",
  );

  const calculatorAction = fs.readFileSync(
    path.join(root, "app", "actions", "tax-calculation.ts"),
    "utf8",
  );
  includes(
    calculatorAction,
    "hasOnlySubcategories",
    "Calculator requires selected pilot subcategory",
  );
  // Profit on debt is no longer pinned to the bank-deposit row: all six
  // Section 151 rows are priced, so the calculator must resolve the row from
  // the taxpayer's selected subcategory through the shared flat-route list.
  includes(
    calculatorAction,
    'route: "bank_profit" as const',
    "Profit on debt is priced through the shared flat-route list",
  );
  if (calculatorAction.includes('hasOnlySubcategories("bank_profit"')) {
    throw new Error(
      "Profit on debt must not be restricted to a single Section 151 row",
    );
  }

  console.log("TY2026 dynamic income-subcategory foundation is valid.");
  console.log(
    JSON.stringify(
      {
        catalogRulesRepresented: representedRuleIds.size,
        catalogSubcategoryGroups: optionCount,
        wizardSelectableCards: wizardSelectableCardCount,
        wizardDynamicSteps: wizardStepDefinitions.length,
        hiddenWizardSources: ["imports", "advance_tax"],
        deferredClientConfirmations: deferredOptionCount,
        assertionCount,
        multipleSelections: true,
        persistedSelections: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (originalTsLoader) Module._extensions[".ts"] = originalTsLoader;
  else delete Module._extensions[".ts"];
}
