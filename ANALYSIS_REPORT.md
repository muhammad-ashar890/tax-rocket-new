# TaxRocket - Filing System Analysis + WHT Rate Card PDF Verification

**Date:** 2026-08-24
**PDF:** `20258181281745641WHT-RateCard.pdf` - Withholding Income Tax Rate Card UPDATED UP TO JUNE 30, 2025 AS PER FINANCE ACT, 2025 (14 pages)
**Repo:** muhammad-ashar890/tax-rocket

---

## 1. PDF Rules vs Code Implementation - Kya Sahi Laga Hai?

### PDF me jo Sections hain (29 sections total):

| Section | Description | Code me Status |
|---------|-------------|----------------|
| 148 | Imports (Part-I, II, III, SRO 1125, Pharma, EV CKD, Mobile PCT) | ✅ 10 rules catalogued in `catalog.ts` - ATL 1%/2% etc match PDF exactly |
| 149 | Salary slabs | ✅ Perfect match - 0-600K 0%, 600K-1.2M 1% excess, 1.2-2.2M 6000+11%, 2.2-3.2M 116K+23%, 3.2-4.1M 346K+30%, 4.1M+ 616K+35% + 9% surcharge above 10M |
| 149(IA) | Pension | ✅ 0% up to 10M, 5% above 10M + 10% surcharge if age <70. Age 70+ case PDF me bhi silent hai - code sahi NEEDS_RULES deta hai |
| 150 | Dividend (IPP 7.5%, REIT 15%, Mutual funds 25%/15% composite, SPV etc) | ✅ 7 rules, composite wali ko sahi block kiya hai |
| 151 | Profit on Debt (Bank deposit 20%, Govt securities 20%, Other 15%, Sukuk company 25%, individual >1M 12.5%, <1M 10%) | ✅ 6 rules, amount band condition sahi hai |
| 151A | Gain on debt securities 15% | ✅ |
| 152 | Non-residents (1,1A,1AA,1AAA,1BA,1C,1D,1DA,1DB + 2A a,b,c) | ✅ 19 rules - single rate wale (12 rows) ka Non-ATL blank hai PDF me, code me DEFAULT use hota hai sahi |
| 153 | Goods/Services/Contracts + e-commerce | ✅ 15 rules - IT/ITES 4%, advertising 1.5%, other 15% etc sahi |
| 154 | Exports 1% | ✅ |
| 154A | Export of Services PSEB 0.25% vs other 1% | ✅ |
| 155 | Rent immovable - Individual slab + Company 15% | ✅ Individual: 0-300K 0%, 300-600K 5% excess, 600K-2M 15K+10%, 2M+ 155K+25% - exact PDF |
| 156 | Prizes 15%/20% | ✅ |
| 156A | Petroleum 12% | ✅ |
| 231AB | Cash withdrawal non-ATL 0.8% | ✅ |
| 231B | Motor vehicles (value % + fixed + 2A lease) | ✅ 23 rules, endnote non-CC vehicle 5M+ ka special 3% aur 20K fixed bhi catalogued but NEEDS_EXTERNAL_DETAIL |
| 231C | Foreign domestic workers 200K/400K | ✅ |
| 233 | Brokerage 10%/8%/12% | ✅ |
| 234 | Motor vehicle tax annual/lump-sum + goods/passenger | ✅ 19 rules |
| 235 | Electricity commercial/industrial/domestic non-ATL | ✅ 6 rules - commercial above 20K 1950+12%, industrial 1950+5% sahi |
| 236 | Telephone 10% above 1000 + internet/mobile 15% | ✅ |
| 236A | Auction 10%/5% | ✅ |
| 236C | Transfer immovable 4.5%/5%/5.5% ATL + 11.5% NON_ATL + 7.5%/8.5%/9.5% Late Filer | ✅ Late filer rates catalogued |
| 236CA | Foreign TV serials 1M/episode, play 3M, ad 100K/sec | ✅ |
| 236CB | Functions 10% | ✅ |
| 236G | Distributor fertilizer 0.25%/0.70% other 0.10%/2% | ✅ IMPORTANT: Non-ATL double nahi hai, code sahi handle karta hai |
| 236H | Retailer 0.5%/2.5% | ✅ |
| 236K | Purchase immovable 1.5%/2%/2.5% ATL + 10.5%/14.5%/18.5% NON + 4.5%/5.5%/6.5% Late | ✅ |
| 236Y | Card remittance abroad 5% | ✅ |
| 236Z | Bonus shares 10% | ✅ |

**Total Expected:** 152 rules - Code me bhi 152 hain. Validation `validate-catalog.ts` me count check hai.

### PDF Rules - Kya Missing ya Galat Hai?

1. **LATE_FILER ka use nahi ho raha:** `catalog.ts` me 236C aur 236K ke liye LATE_FILER rates hain (7.5%,8.5%,9.5% etc) lekin `tax-calculation.ts` me `parseManualTaxpayerListStatus` sirf ATL/NON_ATL allow karta hai. UI me Late Filer option hi nahi hai. So agar user Late Filer hai to bhi ATL rate lagega - **BUG**.

2. **Advance Tax routes calculate nahi hote:** PDF ke 231B, 231AB, 231C, 234, 235, 236, 236A, 236C, 236CA, 236CB, 236G, 236H, 236K, 236Y, 236Z ye sab `advance_tax` source me hain. Lekin `FLAT_ROUTE_DEFINITIONS` me `advance_tax` hi nahi hai! Iska matlab:
   ```ts
   // tax-calculation.ts line 400 ke aas paas
   const FLAT_ROUTE_DEFINITIONS = { bank_profit, foreign_income_assets, services, ... } // advance_tax missing
   ```
   Result: User agar "advance_tax" select karega to `unroutedSources` me jayega aur NEEDS_RULES error ayega: "no TY2026 route is implemented". Client agar chahta hai ke vehicle tax, electricity, property transfer bhi estimate me aaye to ye bada gap hai.

3. **Imports aur Agriculture ka bhi same:** `imports` source TAX_ACTIVITY_SOURCES me hai, calculation me nahi. `agriculture`, `sales_tax_fed_withholding`, `aop_company_links` ka to catalog me bhi rule nahi hai.

4. **Composite aur Range wale rates block hote hain:** 
   - `TY2026-150-DIVIDEND-MUTUAL-FUND-PROPORTIONAL` = 25% debt + 15% equity - `evaluateRateCardValue` COMPOSITE ko null return karta hai, sahi block hota hai NEEDS_RULES ke saath. Ye sahi hai kyunki ledger me split ka evidence nahi hai.
   - Mobile phones 148 range (Rs 70-11500) - RANGE type - sahi block.

5. **REFERENCE type:** `149(IA) former employer` rule Section 149 ko reference karta hai. `evaluateRateCardValue` REFERENCE ko null deta hai, to ye bhi NEEDS_RULES dega. Isko resolve karna chahiye tha.

6. **PER_UNIT:** Goods transport Rs 2.50 per kg laden weight - PER_UNIT - null return - NEEDS_RULES. Ye bhi gap hai agar client isko calculate karwana chahta hai.

7. **Surcharge Logic Sahi Hai:** PDF kehta hai "surcharge @ 9%" salary above 10M pe. Code me `basis: "CALCULATED_TAX"` hai aur `calculateSurchargeOnTax` me sirf calculated tax pe lagta hai, taxable income pe nahi. Verification script me guard hai ke 9% of taxable income (1,080,000) nahi lag raha. ✅ Correct.

---

## 2. Filing System ke Bade Masle (Critical Issues)

### A. Architecture / Data Model

1. **One Draft per User per TaxYear (schema.prisma line 97):**
   ```prisma
   @@unique([userId, taxYear])
   ```
   Matlab user ek saal me sirf ek filing kar sakta hai. Revised return ya multiple drafts nahi. Agar user galti kare to purana delete karna padega. Isse better `@@unique([userId, taxYear, version])` ya alag revision system hota.

2. **Tax Calculation Revision Delete:**
   ```ts
   await tx.filingTaxCalculationLine.deleteMany({ where: { filingDraftId } })
   ```
   Har recalculation pe purani lines delete ho jati hain. Audit trail khatam. Packet approval ke liye history chahiye hoti hai. Abhi sirf latest revision bachta hai.

3. **Money Handling Ab Fix Ho Gaya:**
   Pehle Float tha, ab Decimal(18,2) + `sumMoney`/`netMoney` exact arithmetic. `lib/money.ts` me sahi guards hain: `Decimal + number` concatenation ka issue handle kiya. Good.

4. **Document Storage Local Filesystem:**
   `fileUrl` local path hai. Vercel/serverless ya multi-instance pe files gayab ho jayengi. Production ke liye S3/R2 chahiye. `verify-cleanup-hygiene` script bhi hai - orphan files ka issue.

### B. Filing Completeness & Reconciliation

5. **Strict Completeness Gate - Sahi lekin UX heavy:**
   - Har bank account ke liye exactly 1 document + 1 statement chahiye, aur transaction ka `bankStatementId` current statement se match hona chahiye. Ye `filing-completeness.ts` me sahi hai, lekin user agar statement replace kare to purane transactions block kar dete hain.
   - Transfer matching: `findLikelyInternalTransferPairs` - agar ek side ka match nahi mila ya multiple matches mile to blocker. Ye bank narration pe keyword se nahi, amount/date se match karta hai - better.

6. **Reconciliation Hash Revision:**
   `calculateAuthoritativeReconciliation` me SHA256 hash banta hai pura payload ka (accounts, transactions, ledger). Ye detect karta hai agar Mizan ke baad data change hua. Strong design. Lekin auto-adjustment entries `RECONCILIATION_AUTO_ADJUSTMENT` source se exclude hain - ye sahi hai warna loop banta.

7. **Withholding Duplicate Warning Sirf Warning Hai:**
   `resolveTaxWithheld` me certificate (149) + ledger (151) add hote hain. Agar ledger me "salary tax" jaisa description ho to duplicate warning nikalta hai lekin calculation nahi rokta. User refund inflate karke file kar sakta hai aur months baad FBR notice ayega. Isse blocker banana chahiye tha ya UI me mandatory checkbox.

### C. Tax Calculation Gaps

8. **Progressive Routes Combination Block:**
   Salary + Pension + Rent (individual) teeno progressive hain. Code sahi NEEDS_RULES deta hai:
   > "Confirm whether one slab is read against combined income or each reads its own slab"
   Ye FBR ka assessment rule WHT card me nahi hai, so sahi block hai. Lekin UX me iska solution nahi diya - user ko guide nahi milta kya karna hai.

9. **Flat Route Multi-Subcategory Block:**
   Agar user Services me 2 categories select kare (e.g., IT/ITES 4% + Advertising 1.5%) to code kehta hai:
   > "ledger records a single amount per source, so there is no evidence for how the income divides"
   Aur NEEDS_RULES. Sahi safety hai lekin ledger me per-subcategory split allow karna chahiye tha. Abhi user ko manually ledger entries split karni padti hain.

10. **Filer Status - LATE_FILER Missing:**
    Upar bataya - PDF me late filer rates hain lekin UI/calculation me option nahi.

11. **Advance Tax Not Priced:**
    Sabse bada functional gap - client ne WHT Rate Card diya jisme 231B, 234, 235 etc hain lekin app unko calculate hi nahi karti. User confuse hoga.

### D. Security / Production Readiness

12. **Ownership Checks Hain Lekin Audit Chahiye:**
    Har action me `userId` check hai (`getOwnedDraft`). Good. Lekin `Document` aur `BankStatement` ke `bankAccountId` nullable hai aur orphan check completeness me hai. `verify-route-protection` script hai.

13. **FBR Connection Fake Hai:**
    `FbrConnection` model me `agentId`, `status` etc hain lekin actual FBR API integration nahi. README me bhi likha hai "trusted desktop agent handoff, not complete FBR submission". Production se pehle real integration chahiye.

14. **Rate Limiting:**
    `lib/rate-limit.ts` hai lekin har action me use ho raha hai ya nahi check karna padega.

15. **Gemini API:**
    Document extraction Gemini se hota hai. Key nahi hai to extraction fail. Fallback manual entry ka hai lekin UX clear nahi.

16. **XLSX Parsing Security:**
    `@e965/xlsx` fork use ho raha hai (SheetJS ka). `verify-upload-safety` script hai lekin MIME type spoofing check karna chahiye.

---

## 3. PDF Rules Implementation - Detailed Verification

### Salary (Section 149) - 100% Match
- PDF Page 1-2 slabs exact match code me
- Surcharge 9% above 10M calculated tax pe - code sahi

### Pension (149 IA)
- PDF: up to 10M 0%, above 10M age below 70: 5% excess + 10% surcharge
- Code: same. Age 70+ ka PDF me bhi zikr nahi, code NEEDS_RULES - correct

### Bank Profit (151)
- PDF Page 3:
  - Bank/FI deposit 20% ATL / 40% NON
  - Govt securities non-individual 20%/40%
  - Other 15%/30%
  - Sukuk company 25%/50%, individual/AOP >1M 12.5%/25%, <1M 10%/20%
- Code: 6 rules exact same percentages, amount condition for >1M / <1M sahi

### Property Rent (155)
- PDF Page 7: Individual 0-300K nil, 300-600K 5% excess, 600K-2M 15K+10%, 2M+ 155K+25%, Company 15%/30%
- Code: exact

### Business / Services / Dividend etc
- Percentages match PDF, especially non-double cases like 236G fertilizer 0.25%/0.70% (not 0.5%) code me sahi catalogued hai
- Composite mutual fund deliberately excluded - sahi

### Missing Details (PDF kehta hai external detail chahiye)
- Mobile phones PCT 8517.1219 Rs 70-11500 range - PDF kehta hai band table chahiye - code NEEDS_EXTERNAL_DETAIL
- Vehicle non-CC 5M+ 3% - PDF endnote 1 - code NEEDS_EXTERNAL_DETAIL with note
- Ye sahi handling hai

---

## 4. Immediate Fix Karne Wale Masle (Priority)

### P0 - Functional Bugs
1. **LATE_FILER support add karo:** UI me 3rd option + `parseManualTaxpayerListStatus` me LATE_FILER allow + `selectStatusRate` me LATE_FILER fallback
2. **Advance Tax ko ya to calculate karo ya UI se hatao:** Agar client chahta hai ke 231B/234/235 etc estimate me aaye to `FLAT_ROUTE_DEFINITIONS` me `advance_tax` add karna padega with subcategories. Nahi to subcategory step se advance_tax hatao taake user select hi na kare.
3. **REFERENCE type resolve karo:** `evaluateRateCardValue` me REFERENCE case me actual Section 149 ka band lookup karo.

### P1 - Safety / UX
4. **Withholding duplicate ko blocker banao:** Warning ke saath checkbox "I confirm these are separate payments" mandatory karo before packet approval.
5. **Flat route split UX:** Ledger me subcategory field add karo taake user ek source ke andar multiple categories ka amount split kar sake.
6. **Tax calculation history preserve karo:** `deleteMany` ki jagah `calculationRevision` ke saath history rakho, latest ko flag karo.

### P2 - Production
7. **Object storage:** Local filesystem se S3 pe jao
8. **FBR integration:** Agent handoff ka real spec document karo
9. **One draft per year constraint hatana:** Revised returns ke liye allow multiple drafts ya versioning
10. **Rate limiting audit:** Har server action pe rate-limit check lagao

---

## 5. Achhi Cheezen Jo Sahi Ki Hui Hain

- **Catalog validation:** 152 rules count, section counts, page coverage, duplicate ID check - `validate-catalog.ts` strong hai
- **Surcharge on calculated tax:** Client-confirmed rule sahi implement hai, common mistake (gross pe lagana) avoid kiya
- **Money precision:** Decimal migration + `sumMoney`/`netMoney` - floating point tolerance hataya
- **Reconciliation revision hash:** SHA256 of full payload - stale Mizan detection strong
- **Filing completeness:** Account-complete validation, orphan statement/transaction checks, transfer pair matching - bahut detailed
- **Subcategory steps:** Dynamic wizard steps based on incomeSources - `getTy2026SubcategoryStepKeys`
- **Flat vs Progressive separation:** `FLAT_ROUTE_DEFINITIONS` data-driven, new flat route add karna easy
- **Withholding source separation:** Certificate vs ledger ka conservative addition + warning

---

## 6. Conclusion

**PDF Rules:** 90% sahi implemented hain. Jo core income routes client ke liye important hain (salary, pension, rent, bank profit, dividend, services, business, etc) wo exact PDF percentages se match karte hain. Jo block hote hain (mobile phones, composite mutual fund, non-CC vehicle) wo sahi NEEDS_RULES dete hain kyunki PDF me hi external table chahiye.

**Filing System:** Architecture strong hai lekin 2 bade gaps hain:
1. Advance Tax (231B, 234, 235 etc) catalogued to hai lekin calculate nahi hota - ya to implement karo ya UI se nikalo
2. LATE_FILER rates PDF me hain lekin app me use nahi hote

Baaki masle mostly production hardening ke hain (storage, FBR real integration, audit trail, rate limiting).

Agar client ka primary use-case salary + bank profit + rental + services hai to system pilot ke liye ready hai, lekin vehicle/property/electricity advance tax estimate chahiye to uske liye `tax-calculation.ts` me `advance_tax` ko flat routes me add karna padega.

---
Generated by analysis of `/home/user/tax-rocket` + WHT Rate Card PDF (14 pages)
