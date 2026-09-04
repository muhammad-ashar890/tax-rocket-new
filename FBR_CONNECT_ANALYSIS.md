# FBR Connect - Client Files Analysis

**Files Received:**
- `worker.md` - Worker / Desktop Agent Technical System (344 lines)
- `IRIS_System_Field_Codes_Extracted.csv` - 536 rows, tab-separated, IRIS portal field codes

---

## 1. worker.md Kya Kehta Hai?

Ye file batati hai ke **TaxRocket ka FBR filing system hybrid hai**, sirf Next.js nahi:

**Architecture (Intended Production):**
```
Cloud App (Next.js) 
  -> Prepares, validates, packet hash, approval, job queue
  -> MySQL (Prisma) - trusted_devices, local_agent_jobs, packets, approvals, audit_events
  -> Google Cloud Storage - docs, artifacts, installer hosting
  -> Electron Desktop Agent (Windows) - local trusted app
    -> Opens FBR IRIS portal locally in persistent partition: persist:fbr-iris-{userId}
    -> Keeps IRIS session LOCAL, never uploads OTP/CAPTCHA/PIN to backend
    -> Polls backend for jobs, fills IRIS fields, pauses for human actions
```

**Flow (12 steps se 19 steps):**
1. User web app me filing banata hai, docs upload
2. Backend GCS me store + extraction + ledger + reconciliation + packet version/hash
3. User packet approve karta hai + consent for local automation
4. User FBR Connect page pe trusted desktop connect karta hai
5. Backend short-lived launch token banata hai: `POST /api/fbr-connect/desktop/session`
6. Desktop agent launch accept karta hai 2 tarah: `http://127.0.0.1:37219/connect` ya `taxrocket-connect://` deep link
7. Agent register: `POST /api/fbr-connect/desktop/register` -> `TrustedDevice` record + safeStorage token
8. User IRIS me locally login karta hai
9. Agent ready mark: `POST /api/fbr-connect/desktop/ready` -> `local_fbr_connected_at`
10. Backend job queue: `tax_dry_run` ya `tax_assisted_filing`
11. Agent polls: `POST /api/local-agent/jobs/next`, `GET /context`, `POST /status`
12. Agent IRIS automation karta hai, screenshots/logs bhejta hai, human pause points pe rukta hai (OTP, captcha, PIN, PSID/payment, final submit)

**Main Tables (Jo abhi tumhare repo me nahi hain):**
- `trusted_devices` - desktop devices
- `local_agent_jobs` - queue
- `tax_filing_packets` - packets (tumhare me `filingPackets` hai)
- `tax_client_approvals` - approvals
- `tax_audit_events` - audit

**Job Statuses:**
`created` -> `offered_to_device` -> `accepted_by_device` -> `running` -> `awaiting_user_action` -> `completed` / `failed` / `cancelled` / `expired`

**Job Types:**
- `tax_dry_run` - fills fields, stops at final review gate, no final submit
- `tax_assisted_filing` - supervised pilot, pauses at human gates

**Desktop App Download:**
- Folder: `electron-connect`
- Dev: `npm run desktop-connect:dev`
- Build: `npm --prefix electron-connect run dist:win`
- Upload: `npm run desktop-installer:upload` -> GCS
- Endpoint: `GET /api/downloads/dld-connection/windows` (naming issue - still dld-connection)

**Bot Implementation:**
- Electron `BrowserWindow`, persistent session partitions, `webContents.executeJavaScript`, DevTools commands
- Partition: `persist:fbr-iris-{partitionKey}` per user
- Does NOT upload IRIS cookies to backend - stays local

**Portal Strategies:**
- IRIS 2.0 / Angular: DOM selectors, `formControlName`
- Classic IRIS / PrimeFaces JSF: JSF table selectors, PrimeFaces JS calls
- Selector bundle from: default in `fbr-agent-config.ts` + user settings + DB global bundle (allows updates without deploy)

**Production Switches (Env Vars):**
- `FBR_USE_MOCK_IRIS=false`
- `FBR_IRIS_LOGIN_URL`, `FBR_IRIS_READY_SELECTOR`, `FBR_IRIS_READY_URL_PATTERN`, `FBR_IRIS_HOST_ALLOWLIST`
- `FBR_IRIS_DRY_RUN_URL`, `FBR_IRIS_REVIEW_GATE_SELECTOR`, `FBR_IRIS_FINAL_SUBMIT_SELECTOR`, etc.

**Known Issues (worker.md me mention):**
1. **Wiring Issue:** `src/app/fbr-connect/fbr-connect-client.tsx` has actual UI actions for launch, download, queue dry runs, assisted filing, pause confirm - but NOT mounted by active `/tax/fbr-connect` page. Active page only shows status/history, quick actions link back to approval/payment instead of queue/launch APIs.
2. **Naming Issue:** Installer endpoint still `/api/downloads/dld-connection/windows` but app is `Tax Rocket Portal Agent` with `taxrocket-connect://`
3. **Classic Issue:** Worker uses pause actions `classic_final_review` and `classic_pin_entry` but backend resume APIs only accept standard assisted actions - names need alignment.

---

## 2. IRIS_System_Field_Codes_Extracted.csv Kya Hai?

**536 rows, tab-separated, IRIS portal ke field codes.**

**Columns:** Portal_Area, Section, Top_Tab, Row_Level, Field_Description, System_Code, Display_Order, Occurrence_Index, Table_Columns, Source_HTML

**Portal Areas:**
- Simplified Return of Income (Computations)
- Employment (Salary) - Code 1000 = Income from Salary, 1009 = Pay/Wages, 1049 = Allowances, 1008 = Pension/Annuity
- Property (Receipts/Deductions) - 2000 = Income from Property, 2001 = Rent Received, 2031 = 1/5th repairs, etc.
- Business (7F Builders, Adjustments, Assets, Inadmissible/Admissible Deductions, Management Expenses, Manufacturing, Other Revenues)
- Capital Gain (4000, Long Term 4006, Short Term 4026)
- Other Sources (5000) - 5003041 Behbood Certificates, 5002 Royalty, 500312 Profit on Debt, 5007 Annuity/Pension
- Foreign Sources / Agriculture (6000, 6100)
- Tax Chargeable / Payments:
  - Adjustable Tax (640000) - 64010002 Import @1%, 64020004 Salary u/s 149, 64040002 Profit on Debt u/s 151, 64050007 Non-Resident u/s 152, 64060002 Goods @1%, 64080001 Rent u/s 155, 64100101 Cash withdrawal 231AB, 64100301 Motor Vehicle 231B, 64130001 Goods Transport 234, 64150001 Telephone 236, 64150101 Auction 236A, 64150301 Property Transfer 236C, 64150407 Functions 236CB, 64150701 Distributors 236G, 64151101 Property Purchase 236K, 64151905 Card remittance 236Y, etc.
  - Average Tax, Capital Assets (7100-7108), Computations (9000-9329), Deductible Allowances (9009), Minimum Tax (64000102), Tax Credits, Tax Reductions, etc.
- 116 - Wealth Statement (Personal Assets 7001-7029, Expenses 7089, Reconciliation 703001-703004)

**Why Important?**
Ye codes `portalFieldMap` me use honge jo filing packet snapshot me jayega. Electron agent in codes se IRIS fields fill karega.

**Example Mapping Needed:**
- Our `ledgerEntries` Category BANK_PROFIT Amount 1M -> IRIS Code 500312 (Profit on Debt) + 64040002 (Adjustable Tax Profit on Debt u/s 151)
- Our salary income -> Code 1000 (Income from Salary) + 1009 (Pay/Wages) + 64020004 (Salary u/s 149 adjustable tax)
- Our rent 15L -> Code 2001 (Rent Received) + 64080001 (Rent u/s 155)
- Our property transfer 50M -> Code 64150301 (Sale/Transfer u/s 236C)

**Current Gap in Repo:**
`app/actions/packet.ts` me `snapshot` me sirf:
```ts
{
  filing: { taxYear, filerType, ... },
  documents: [...],
  ledgerEntries: [...]
}
```
**`portalFieldMap` missing hai!** Iske bina Electron agent ko pata nahi kaunsa ledger entry kaunse IRIS code pe jayega.

---

## 3. Current Repo vs Intended Architecture - Gap Analysis

| Feature | worker.md Intended | Current Repo (tax-rocket) | Gap |
|---------|-------------------|---------------------------|-----|
| DB | MySQL + trusted_devices, local_agent_jobs, tax_client_approvals, tax_audit_events | PostgreSQL + only fbrConnections, filingPackets | Missing 3 tables + MySQL vs PG |
| Storage | GCS bucket | Local filesystem `uploads/` | Needs GCS |
| Desktop Agent | Electron app in `electron-connect/` | No electron-connect folder | Missing entire desktop app |
| Launch Token | `POST /api/fbr-connect/desktop/session` creates signed token + deep link | No such route, only `startFbrConnectionAction` sets WAITING_FOR_AGENT | Missing launch/session/register/ready routes |
| Job Queue | `POST /api/local-agent/jobs/next` etc | No job queue, only FbrConnection status | Missing job system |
| Packet Snapshot | Includes `portalFieldMap` with IRIS codes | Only filing + docs + ledger | Missing field map |
| FBR Connect UI | `fbr-connect-client.tsx` with launch, download, queue dry run, pause confirm | `fbr-connect-panel.tsx` only shows status + Connect button, no download/queue | Wiring issue - client not mounted |
| Download Endpoint | `/api/downloads/dld-connection/windows` serves .exe via GCS signed URL | No downloads route | Missing |
| IRIS Selectors | `fbr-agent-config.ts` + DB bundle | No selector config | Missing |
| Dry Run vs Assisted | Two job types with pause points | Only WAITING_FOR_AGENT status | Missing |

---

## 4. What to Implement Next for FBR Connect?

### Phase 1: Backend Foundation (1-2 days)
1. **Add missing tables to Prisma schema:**
   ```prisma
   model TrustedDevice {
     id, userId, deviceName, deviceTokenHash, partitionKey,
     localFbrConnectedAt, lastSeenAt, status, etc.
   }
   model LocalAgentJob {
     id, filingDraftId, trustedDeviceId, jobType (tax_dry_run / tax_assisted_filing),
     status, payloadJson, resultJson, etc.
   }
   model TaxAuditEvent { ... }
   ```

2. **Create API routes:**
   - `POST /api/fbr-connect/desktop/session` - create launch token
   - `POST /api/fbr-connect/desktop/register` - register device
   - `POST /api/fbr-connect/desktop/ready` - mark ready
   - `POST /api/local-agent/jobs/next` - agent polls
   - `GET /api/local-agent/jobs/[jobId]/context` - returns packet + portalFieldMap + signed doc URLs
   - `POST /api/local-agent/jobs/[jobId]/status` - status updates

3. **Build portalFieldMap in packet generation:**
   - Use IRIS CSV to map our categories to system codes
   - Example: `BANK_PROFIT` -> `500312` + `64040002`
   - Include in snapshotJson

### Phase 2: Electron App (3-5 days)
- Copy `electron-connect` folder from old project (if client has) or create new
- Implement main.js, portal-agent.js with persistent partitions
- Implement localhost bridge 37219 and deep link handler
- Implement job polling and IRIS filling logic using selector bundle

### Phase 3: UI Wiring (1 day)
- Mount `fbr-connect-client.tsx` in `/tax/fbr-connect` page
- Add download button for Windows installer
- Add queue dry run / assisted filing buttons
- Add pause confirmation UI (OTP, captcha, etc.)

### Phase 4: Testing with Mock IRIS
- Set `FBR_USE_MOCK_IRIS=true` initially
- Test dry run fills fields from portalFieldMap
- Capture screenshots/logs

---

## 5. Immediate Questions for Client (Add to CLIENT_QUESTIONS.md)

**Q17: Electron App Source Code Kahan Hai?**
- `electron-connect` folder old project me hai ya naya banana hai?
- Agar hai to repo ka access dein

**Q18: GCS Bucket Configured Hai?**
- `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, etc env vars hain?
- Ya local filesystem hi use karna hai for now?

**Q19: IRIS Portal Version Kaunsa Use Karna Hai?**
- IRIS 2.0 Angular ya Classic PrimeFaces? Ya dono support?
- `IRIS_System_Field_Codes_Extracted.csv` me kaunse HTML source se codes aaye? (Information System.html etc)

**Q20: Portal Field Mapping Confirm Karna Hai?**
- CSV me 536 codes hain, kaunse codes hamare ledger categories se map honge?
- Example: Hamara `RENT` category -> Code 2001 ya 5005? Confirm list chahiye

**Q21: FBR Connect UI - Kya fbr-connect-client.tsx Old Repo Me Hai?**
- worker.md kehta hai woh file actual actions rakhti hai lekin active page pe mount nahi
- Kya woh file client ke paas hai? Share karein

---

## Bottom Line

- `worker.md` batata hai intended architecture Electron + GCS + job queue hai, current repo me sirf placeholder `FbrConnection` hai
- `IRIS_System_Field_Codes_Extracted.csv` 536 codes deta hai jo `portalFieldMap` banane ke liye chahiye, current packet me ye map missing hai
- FBR Connect ko production ready karne ke liye 3 missing tables + 5 API routes + Electron app + portalFieldMap mapping chahiye
- Ye 1-2 week ka kaam hai, Late Filer fix se alag

