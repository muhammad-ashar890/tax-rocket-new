# FBR Connect - Phase Plan (Implementation Started)

**Date:** 2026-05-13
**Client Files:** worker.md (344 lines) + IRIS_System_Field_Codes_Extracted.csv (536 rows)
**Status:** Phase 1 started, code committed

---

## Summary - Client Ne Kya Diya?

### worker.md
Ye file batati hai ke FBR filing **sirf Next.js se nahi, Electron desktop app se hogi**:
- Cloud (Next.js) = packet prepare + hash + GCS + job queue
- Desktop (Electron) = FBR IRIS portal local me kholega, OTP/PIN/Captcha kabhi server pe nahi jayega
- Flow: Next.js -> GCS -> Launch Token (deep link `taxrocket-connect://` + localhost `127.0.0.1:37219`) -> Electron register -> Ready -> Job poll -> Fill fields using IRIS codes -> Pause for human -> Complete

### IRIS_System_Field_Codes_Extracted.csv
536 rows, IRIS portal ke field codes:
- Salary 1000, Pay 1009, Pension 1008
- Rent 2001, Repair 2031
- Profit on Debt 500312
- CGT 4000/4006/4026
- Adjustable Tax: Salary 149 = 64020004, Bank Profit 151 = 64040002, Property Transfer 236C = 64150301, Purchase 236K = 64151101 (ye hamara Late Filer fix ka core hai)

---

## Phase Plan

### ✅ Phase 0: Analysis (DONE)
- [x] worker.md read + gap analysis
- [x] IRIS CSV parsed + mapping proposal
- [x] Current repo audit (fbr-connect-panel.tsx, page.tsx, fbr.ts)
- [x] Docs created: FBR_CONNECT_ANALYSIS.md, PORTAL_FIELD_MAP_PROPOSAL.md

### 🔨 Phase 1: Backend Foundation (STARTED - Today)

**Goal:** Packet me portalFieldMap + DB tables + API routes

**Tasks Done:**
1. **Prisma Schema Updated** (`prisma/schema.prisma`):
   - Added `TrustedDevice` (deviceTokenHash, partitionKey `persist:fbr-iris-{user}`, localFbrConnectedAt)
   - Added `LocalAgentJob` (jobType: tax_dry_run / tax_assisted_filing, statuses: created -> offered -> accepted -> running -> awaiting_user_action -> completed/failed)
   - Added `TaxAuditEvent` (audit trail)
   - Updated `FbrConnection` with partitionKey, deviceId
   - Updated `User` relations

2. **IRIS Codes Library** (`lib/tax/iris-field-codes.ts`):
   - 40+ IRIS codes constants from CSV
   - CATEGORY_TO_IRIS_MAP: SALARY -> 1000/1009, RENT -> 2001, BANK_PROFIT -> 500312 + 64040002, 236C -> 64150301, 236K -> 64151101
   - TAX_SECTION_TO_IRIS_CODE mapping

3. **Portal Field Map Builder** (`lib/tax/portal-field-map.ts`):
   - `buildPortalFieldMap()` converts ledgerEntries + taxCredits -> IRIS fields
   - Handles pension exempt/taxable split, rent 1/5th repair, adjustable taxes
   - Returns versioned map with incomeFields, adjustableTaxFields, wealthFields, computationHints, selectorBundle

4. **Packet Integration** (`app/actions/packet.ts`):
   - Now fetches `filingTaxCredit` + ledgerEntries with IDs
   - Builds `portalFieldMap` in snapshot
   - Snapshot now: `{ filing, documents, ledgerEntries, taxCredits, portalFieldMap }`
   - Electron agent will use this to fill IRIS

5. **Desktop Agent Lib** (`lib/tax/fbr-desktop.ts`):
   - Token generation, partitionKey, hash, deep link builder
   - Job types/statuses constants
   - Pause actions: otp_required, captcha_required, pin_required, classic_pin_entry, final_review, classic_final_review, psid_payment
   - Normalizes legacy names (worker.md known issue fix)

6. **API Routes Created:**
   - `POST /api/fbr-connect/desktop/session` - creates launch token (10 min expiry), pending TrustedDevice, returns deepLink `taxrocket-connect://` + localhost URL, audit event
   - `POST /api/fbr-connect/desktop/register` - Electron registers with launchToken, marks ACTIVE, returns auth config
   - `POST /api/fbr-connect/desktop/ready` - Electron marks localFbrConnectedAt, updates FbrConnection to AGENT_CONNECTED
   - `POST /api/local-agent/jobs/next` - Agent polls, assigns unassigned jobs
   - `GET /api/local-agent/jobs/[jobId]/context` - Returns packet snapshot + portalFieldMap + selectors (critical for agent)
   - `POST /api/local-agent/jobs/[jobId]/status` - Agent reports running/awaiting_user_action/completed/failed, handles pause actions, updates FbrConnection
   - `GET /api/downloads/taxrocket-agent/windows` + legacy `/api/downloads/dld-connection/windows` - placeholder with build instructions

7. **Job Queue Actions** (`app/actions/fbr-jobs.ts`):
   - `queueDryRunJobAction()` - creates tax_dry_run job, requires approved packet, checks no active job
   - `queueAssistedFilingJobAction()` - creates tax_assisted_filing, requires dry run completed first (safety)
   - `getLocalAgentJobsAction()`, `cancelJobAction()`, `resumeJobAfterPauseAction()`, `getTrustedDevicesAction()`

8. **UI Wiring Fixed** (`components/tax/fbr-connect-client.tsx` + `app/tax/fbr-connect/page.tsx`):
   - Created full client component (was missing per worker.md known issue)
   - Now shows: Init Connection, Create Desktop Session (deep link + localhost), Trusted Devices list, Queue Dry Run / Assisted Filing, Job list with pause/resume/cancel, Download Agent buttons, Portal Field Map info
   - Page now mounts FbrConnectClient instead of simple panel

**Remaining in Phase 1:**
- [ ] Run `npx prisma migrate dev --name add_fbr_desktop_agent` (needs DB)
- [ ] Test packet generation includes portalFieldMap (need to run `npm run build` check)
- [ ] Test API routes with mock device token

**Required from Client in Phase 1:**
- ❌ Nothing yet - Phase 1 uses existing data

---

### ⏳ Phase 2: Electron Desktop Agent (NEXT - 3-5 days)

**Goal:** Build `electron-connect/` folder that implements worker.md flow

**Tasks:**
1. Scaffold Electron app:
   ```
   electron-connect/
   ├── package.json (electron-builder config)
   ├── main.js (BrowserWindow, persistent partition persist:fbr-iris-{partitionKey}, safeStorage, deep link handler, localhost bridge 127.0.0.1:37219)
   ├── preload.js (contextBridge)
   ├── portal-agent.js (job polling, IRIS automation, selector execution, screenshot capture)
   ├── fbr-agent-config.ts (selector bundle - IRIS 2.0 Angular vs Classic PrimeFaces)
   └── assets/
   ```

2. Implement main features from worker.md:
   - Deep link handler `taxrocket-connect://connect?token=...`
   - Localhost bridge server on 37219 for `http://127.0.0.1:37219/connect`
   - safeStorage for device token (encrypted)
   - Persistent session partition per user
   - Job polling loop (3 sec interval)
   - Context fetching + portalFieldMap filling
   - Pause handling (OTP, CAPTCHA, PIN, PSID, Final Review) - stays local, never uploads to backend
   - Screenshot/logs capture + upload to backend via status endpoint

3. Build & Distribution:
   - `npm --prefix electron-connect run dist:win` -> .exe
   - `npm run desktop-installer:upload` -> GCS (needs credentials)
   - Test with mock IRIS (`FBR_USE_MOCK_IRIS=true`)

**Required from Client in Phase 2:**
- 🔴 **CRITICAL: electron-connect folder source code** - Does client have old Electron app from previous project? If yes, share repo/access. If not, we scaffold new.
- 🔴 **GCS Bucket Config** - `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` or service account JSON? If not using GCS, we can use local filesystem for dev.
- 🟡 **IRIS Portal Version** - IRIS 2.0 Angular or Classic PrimeFaces? Or both? Affects selector bundle.
- 🟡 **Selector Bundle** - Does client have `fbr-agent-config.ts` with selectors from old project? If yes, share.
- 🟡 **Windows Code Signing Certificate** (optional, for production installer)

**If Client Cannot Provide Electron Code:**
- We will scaffold new Electron app from scratch using Electron + TypeScript + Playwright-like automation via `webContents.executeJavaScript`
- Estimate +2 days

---

### ⏳ Phase 3: UI Polish & Integration (1 day after Phase 2)

**Goal:** Make FBR Connect page production-ready

**Tasks:**
- Add real download progress for installer
- Add job history timeline with screenshots
- Add pause confirmation UI that matches worker.md (OTP input stays local but UI shows status)
- Add audit log view (`TaxAuditEvent`)
- Update filing-status.ts to handle new statuses: AGENT_CONNECTED, DRY_RUN_QUEUED, FILING_QUEUED, DRY_RUN_COMPLETED, etc.
- Fix naming: rename endpoint from `dld-connection` to `taxrocket-agent` in all places (worker.md issue)

**Required from Client:**
- 🟡 **UI/UX Feedback** - Review FbrConnectClient UI, suggest changes
- 🟡 **Branding** - App name `Tax Rocket Portal Agent` vs `Dld Connection`? Confirm final name

---

### ⏳ Phase 4: Testing with Mock IRIS (1-2 days after Phase 3)

**Goal:** End-to-end test without real FBR credentials

**Tasks:**
1. Set env:
   ```
   FBR_USE_MOCK_IRIS=true
   FBR_IRIS_LOGIN_URL=http://localhost:3001/mock-iris/login
   FBR_IRIS_READY_SELECTOR=[data-testid="iris-ready"]
   FBR_IRIS_DRY_RUN_URL=...
   ```
2. Create mock IRIS HTML pages that have same field codes (1000, 2001, 500312, 64150301, etc.) as real portal
3. Test flow:
   - Generate packet with test docs (salary 30L, rent 15L, bank profit 10L, property 50M 236C)
   - Verify portalFieldMap has correct codes: 1000, 2001, 500312, 64150301
   - Create desktop session -> Register mock device -> Ready -> Queue dry run -> Agent fills fields -> Screenshots -> Complete
   - Verify audit events
4. Test pause actions: mock OTP page, verify agent pauses and resumes

**Required from Client:**
- 🟡 **Mock IRIS Pages** - Does client have mock IRIS HTML from old project? If not, we create simple ones
- 🟡 **Test FBR Credentials** (for staging, not prod) - To test against real IRIS sandbox if available
- 🟡 **Real IRIS Selectors** - If client has inspected real IRIS portal, share selectors for 1000, 2001, etc.

---

### ⏳ Phase 5: Production Hardening (1 day)

**Goal:** Make ready for production

**Tasks:**
- GCS signed URL implementation for installer download
- Rate limiting on session creation (prevent token spam)
- Device revocation UI
- Job expiration handling (2h dry run, 4h assisted)
- Add `FBR_IRIS_HOST_ALLOWLIST` check (security - only allow iris.fbr.gov.pk)
- Update env vars documentation
- Create `electron-connect/README.md` with build instructions

**Required from Client:**
- 🔴 **Production Env Vars** - Final list of `FBR_*` vars for production
- 🟡 **GCS Bucket** - Production bucket name
- 🟡 **Domain** - Final NEXTAUTH_URL for deep link generation

---

## Current Implementation Status (as of now)

**Files Changed/Created (11 files):**
- `prisma/schema.prisma` - Added 3 models
- `lib/tax/iris-field-codes.ts` - NEW (IRIS codes from CSV)
- `lib/tax/portal-field-map.ts` - NEW (builder)
- `lib/tax/fbr-desktop.ts` - NEW (session/token logic)
- `app/actions/packet.ts` - Updated to include portalFieldMap
- `app/actions/fbr-jobs.ts` - NEW (job queue)
- `app/api/fbr-connect/desktop/session/route.ts` - NEW
- `app/api/fbr-connect/desktop/register/route.ts` - NEW
- `app/api/fbr-connect/desktop/ready/route.ts` - NEW
- `app/api/local-agent/jobs/next/route.ts` - NEW
- `app/api/local-agent/jobs/[jobId]/context/route.ts` - NEW
- `app/api/local-agent/jobs/[jobId]/status/route.ts` - NEW
- `app/api/downloads/taxrocket-agent/windows/route.ts` - NEW
- `app/api/downloads/dld-connection/windows/route.ts` - NEW (legacy)
- `components/tax/fbr-connect-client.tsx` - NEW (full UI, fixes wiring issue)
- `app/tax/fbr-connect/page.tsx` - Updated to mount new client

**Next Command to Run (when DB available):**
```bash
npx prisma migrate dev --name add_fbr_desktop_agent
npx prisma generate
npm run build
```

---

## What to Ask Client NOW vs LATER

**Ask NOW (to unblock Phase 2):**
1. "Electron app ka source code hai old project me? `electron-connect` folder share karein, warna naya scaffold karna padega (+2 days)"
2. "GCS bucket use karna hai ya local filesystem? Agar GCS to credentials de dein"
3. "IRIS 2.0 ya Classic? Dono support karna hai?"

**Ask in Phase 2:**
4. "IRIS selectors ka bundle hai? `fbr-agent-config.ts`?"
5. "Mock IRIS pages hain old repo me?"

**Ask in Phase 4:**
6. "Test FBR credentials for staging?"
7. "Production env vars final list?"

---

## Benefits After All Phases

- **Security:** OTP/PIN/Captcha local hi, server pe nahi jata (bank jaisa)
- **Automation:** 536 IRIS codes se auto-fill, manual error khatam
- **Audit:** Har step hash + screenshot + audit event
- **UX:** User pehle Dry Run dekhega, phir final submit - safe
- **Compliance:** Trusted device + partition per user + safeStorage

**Without these changes:** FBR Connect sirf dummy status page rahega, filing FBR me nahi jayegi.

---

## Quick Test with Current Code (Phase 1 only)

Even without Electron app, you can test Phase 1 now:

1. Generate packet with test docs -> check `portalFieldMap` in DB `filingPackets.snapshotJson`
2. Call `POST /api/fbr-connect/desktop/session` with filingDraftId -> get deep link
3. Simulate Electron register via curl:
   ```bash
   curl -X POST http://localhost:3000/api/fbr-connect/desktop/register \
     -H "Content-Type: application/json" \
     -d '{"launchToken":"<token from session>","deviceName":"Test Device"}'
   ```
4. Queue dry run via UI -> check `localAgentJobs` table
5. Poll jobs/next via curl with deviceToken

This validates backend without needing Electron.
