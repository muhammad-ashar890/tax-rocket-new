# Old Repo Analysis - tax-rocket-old

**Repo:** https://github.com/muhammad-ashar890/tax-rocket-old
**Cloned to:** `/home/user/tax-rocket-old` (SEPARATE from `/home/user/tax-rocket`, NOT mixed)
**Status:** Successfully cloned after secret cleanup, CI failing but code present

---

## What Old Repo Contains (Relevant to FBR Connect)

### 1. electron-connect/ (Real Implementation - 124KB main.js)
**Location:** `/home/user/tax-rocket-old/electron-connect/src/`

**Files:**
- `main.js` (124KB) - Production-grade Electron main process:
  - Handles both DLD (Dubai Land Dept) and FBR flows (`flow: "dld" | "fbr"`)
  - Persistent partitions `persist:fbr-iris-{partitionKey}` and `persist:dld-{partitionKey}`
  - Deep link `taxrocket-connect://` + localhost bridge `127.0.0.1:37219`
  - safeStorage for device token (encrypted JSON)
  - State store: `createStateStore` with `agent-state.json` in userData
  - Auto-capture, worker window, login window
  - Local bridge server with POST /connect handling flow, token, nonce, apiBaseUrl, partitionKey, allowedOrigins, backendAllowlist, desktopAuthConfig
  - FBR desktopAuthConfig: loginUrl, readySelector, readyRejectSelector, readyUrlPattern, useMockIris
  - Mock IRIS support: `mock-iris://login` -> file:// mock-iris/login.html

- `portal-agent.js` (2.5KB) - State store helpers:
  - `createStateStore({app, fs, path, safeStorage})` -> getAgentStatePath, loadAgentState, saveAgentState
  - `isOriginAllowed`, `isBackendAllowed`, `sanitizeBaseUrl`
  - Encrypts agent-state.json if safeStorage available

- `preload.js` - contextBridge:
  - Exposes `window.ejariConnect` with getLaunchState, openDldLogin, captureAndUpload, setAccountReference, openExternal, getLocalBridgeUrl, onLaunchState, onStatusUpdate

- `renderer.html` + `renderer.js` + `styles.css` - Simple status UI for Electron window
  - Shows apiBaseUrl, tokenState, accountReference input, openLoginButton
  - Handles launchState (flow fbr vs dld), status updates

- `mock-iris/` - 14 HTML files for testing without real IRIS:
  - login.html, otp-captcha.html, password-reset.html, dashboard.html, return.html, payment.html, final-review.html, completed.html, classic-portal.html, classic-pin.html, classic-attributes.html, classic-fixed-final-tax.html, classic-other-revenues.html, classic-wealth-statement.html

**Copied to:** `/home/user/tax-rocket/electron-connect/` (real implementation now active)
- main.js (124KB real) + main.js.scaffold-backup (our 8KB scaffold)
- portal-agent.js (2.5KB real state store) + fbr-portal-agent.js (our 9KB PortalAgent class with job polling)
- preload.js, renderer.html, renderer.js, styles.css, mock-iris/ (14 files)
- old-reference-from-tax-rocket-old/ backup

### 2. src/app/fbr-connect/fbr-connect-client.tsx (594 lines - Production Client)
**Old Implementation vs Our Phase 1 Client:**

| Feature | Old (tax-rocket-old) | Our Phase 1 (tax-rocket) |
|---------|---------------------|--------------------------|
| Launch Response | token, launchNonce, apiBaseUrl, partitionKey, desktopAuthConfig (loginUrl, readySelector, readyRejectSelector, readyUrlPattern, useMockIris), allowedOrigins, backendAllowlist, localBridgeUrl, launchUrl | launchToken, partitionKey, deepLink, localhostUrl, expiresAt |
| Desktop Launch | POST to localBridgeUrl with flow, token, nonce, apiBaseUrl, partitionKey, allowedOrigins, backendAllowlist, desktopAuthConfig, fallback to launchUrl (deep link) | POST /api/fbr-connect/desktop/session, then try deep link + localhost bridge separately |
| Dry Run Queue | POST /api/local-agent/tax/dry-run with draftId, returns job publicId | POST via action queueDryRunJobAction -> creates LocalAgentJob tax_dry_run |
| Assisted Queue | POST /api/local-agent/tax/assisted-filing | queueAssistedFilingJobAction |
| Confirm Step | POST /api/local-agent/tax/confirm-step with jobId, action | resumeJobAfterPauseAction |
| Job Display | publicId, type, status, trustedDevice displayName, result.captures (screenshots), result.requiredAction, result.recoveryActions, executionLog, prefillComparison | id, jobType, status, pauseAction, pauseMessage, errorMessage |
| UI | Cards for trusted device, dry-run readiness reasons, assisted readiness, latest dry-run result with screenshots grid, human gates info | Simpler cards: connection status, trusted devices list, job queue, download |

**Old client is more mature** - has readiness checks, screenshot captures, prefill comparison, recovery actions, execution log.

**Our client fixes wiring issue** (was not mounted) and adds portalFieldMap info.

**Recommendation:** For Phase 2, merge old client's features (readiness, screenshots, prefill) into our new client that already has portalFieldMap.

### 3. src/lib/tax/fbr-agent-config.ts (1505 lines)
**Selector Bundle System:**

- Types: IrisPortalType ("iris2" | "irisv1" | "both"), FbrDesktopAuthConfig, FbrRouteSelectorConfig, FbrSelectorBundleSummary, FbrPortalAutomationConfig
- Functions: getPortalTypeForRouteFamily, getPortalTypeForCategory, isClassicPortalRoute
- DEFAULT_SELECTOR_BUNDLE: v8-default-2026-05, version 1, routeSelectors for:
  - simplified_salary_114i, normal_individual_114, normal_individual_114_revised, wealth_statement, pre_step_application, classic_individual_114 (PrimeFaces)
  - COMMON_RETURN_SELECTORS: topMenuSelector, leftCategorySelector, formSelector, formReadySelector, periodSelector, nameSelector, generatePsidSelector, psidDisplaySelector, etc.
- Classic portal selectors use escaped IDs like `#correspondenceTabs\\:returnAmountForm\\:menuPanel` (JSF)
- Env-based config: FBR_IRIS_LOGIN_URL, FBR_IRIS_READY_SELECTOR, etc.
- DB bundle: getActiveFbrSelectorBundle() - allows updating selectors without deploy

**Our implementation:** lib/tax/iris-field-codes.ts + portal-field-map.ts (IRIS codes mapping) - complementary, not overlapping. Old's fbr-agent-config is selectors (DOM), ours is field codes (data). Both needed.

**Copied to:** `/home/user/tax-rocket/electron-connect/old-reference-from-tax-rocket-old/lib-tax/fbr-agent-config.ts` for reference

### 4. src/lib/tax/fbr-dry-run.ts, fbr-assisted-filing.ts, etc.
- fbr-dry-run.ts: getTaxDryRunReadiness() - checks packet, approval, risk flags, wealth reconciliation, IRIS route resolution, supportedInV8, preStepApplicationRequirement
- fbr-assisted-filing.ts: getTaxAssistedFilingReadiness()
- fbr-agent-automation.test.ts, fbr-agent-config.test.ts, etc. - tests
- iris-form-registry.ts, iris-route-resolver.ts - route resolution

**Our implementation:** Simpler readiness (packet exists, no active job, dry run completed first for assisted). Old has more thorough checks (risk flags, wealth reconciliation, route support).

### 5. src/app/api/local-agent/ and src/app/api/agents/
- Old has /api/local-agent/tax/dry-run, /api/local-agent/tax/assisted-filing, /api/local-agent/tax/confirm-step
- Our new has /api/fbr-connect/desktop/session, /register, /ready, /api/local-agent/jobs/next, /context, /status
- Different endpoint naming - need compatibility or migration

### 6. Prisma Migrations
- Old has migration 20260519_stage15_mode1_local_agent_dry_run - likely adds trusted devices, local agent jobs tables
- Our new has similar tables but with slightly different schema (we used PostgreSQL, old may use different)

---

## What to Use From Old Repo

### Immediately Useful (Copy to Current tax-rocket):

1. **electron-connect/src/mock-iris/** (14 HTML files) - Already copied to `/home/user/tax-rocket/electron-connect/mock-iris/` - Use for Phase 4 testing with FBR_USE_MOCK_IRIS=true

2. **electron-connect/src/main.js (124KB)** - Real production Electron main process - Already copied as `/home/user/tax-rocket/electron-connect/main.js` (real) - Use for Phase 2 build

3. **fbr-agent-config.ts selector bundle** - Should be ported to our lib/tax/fbr-agent-config.ts (create new file that merges old selectors with our IRIS codes)

4. **fbr-connect-client.tsx UI patterns** - Old has better UX for screenshots, executionLog, prefillComparison, readiness reasons - Should enhance our FbrConnectClient with these

### Reference Only (Don't Directly Copy, But Learn From):

- fbr-dry-run.ts readiness logic - more thorough than ours, should adopt risk flags, wealth reconciliation checks
- API route structure - old uses /api/local-agent/tax/*, we use /api/local-agent/jobs/* - need to decide final structure (recommend keeping ours as it's more generic, but add compatibility shims for old endpoints)
- Prisma schema - compare old migration with our new schema

### Not Needed (DLD-specific):

- DLD flow parts (dubailand.gov.ae) - old main.js handles both DLD and FBR, we only need FBR flow - can simplify
- Ejari Website (Front End) folder - unrelated to TaxRocket FBR

---

## Current Status After Cloning Old Repo

- ✅ Old repo cloned to `/home/user/tax-rocket-old` (SEPARATE, not mixed with `/home/user/tax-rocket`)
- ✅ electron-connect real implementation copied to `/home/user/tax-rocket/electron-connect/` (main.js 124KB, portal-agent.js state store, mock-iris 14 files, preload, renderer)
- ✅ Old reference backed up to `/home/user/tax-rocket/electron-connect/old-reference-from-tax-rocket-old/`
- ✅ Our scaffold preserved as main.js.scaffold-backup and fbr-portal-agent.js
- ✅ Current tax-rocket still has our Phase 1 backend (portalFieldMap, API routes, job queue, UI client)
- ⏳ Next: Merge old selector bundle into new lib, enhance FbrConnectClient with old's screenshot/prefill features, test with mock-iris

---

## Next Steps

### Phase 2 (Now Unblocked):

1. **Merge Selector Bundle:**
   - Create `/home/user/tax-rocket/lib/tax/fbr-agent-config.ts` that combines:
     - Old's DEFAULT_SELECTOR_BUNDLE (DOM selectors for IRIS 2.0 and Classic)
     - Our IRIS_CODES (field codes 1000, 2001, 500312, 64150301 etc)
   - Keep portalFieldMap builder as is (data mapping), add selector bundle (DOM mapping)

2. **Enhance FbrConnectClient:**
   - Add readiness checks from old fbr-dry-run.ts (packet match, approval, wealth reconciliation, route support)
   - Add screenshot display (old has grid with dataUrl)
   - Add executionLog and prefillComparison display
   - Keep our deep link + localhost bridge + job pause/resume logic

3. **Build Electron Installer:**
   ```bash
   cd /home/user/tax-rocket/electron-connect
   npm install
   npm run dev  # Test with mock-iris
   npm run dist:win  # Build .exe
   ```

4. **Test with Mock IRIS:**
   - Set FBR_USE_MOCK_IRIS=true
   - Use mock-iris/login.html, return.html etc (already present)
   - Test portalFieldMap filling: Salary 30L -> 1000, Rent 15L -> 2001, Bank Profit 10L -> 500312, Property 50M 236C -> 64150301

### Required From Client (Updated):

- ✅ Electron source code - FOUND in old repo (main.js 124KB, mock-iris 14 files)
- ❓ GCS bucket still needed for installer hosting (or use local for dev)
- ❓ IRIS version - old code supports both iris2 (Angular) and irisv1 (Classic PrimeFaces) via getPortalTypeForRouteFamily - so we support both, but need to confirm which to prioritize
- ❓ Production env vars for FBR_* selectors

---

## File Locations (Separation Maintained)

- **Current Project (Active):** `/home/user/tax-rocket/` - Our Phase 1 implementation + merged Electron real code
- **Old Repo (Reference Only):** `/home/user/tax-rocket-old/` - Full old code, NOT mixed, only referenced
- **Old Electron Reference in Current:** `/home/user/tax-rocket/electron-connect/old-reference-from-tax-rocket-old/` - Backup of old electron-connect/src for comparison
- **No Mixing:** Old code never overwrites current tax-rocket's app/ or lib/ except electron-connect/ which we intentionally merged with backup preserved

