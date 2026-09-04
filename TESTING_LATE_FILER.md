# Late Filer Fix - Local Testing Guide

## Quick Test (5 min) - UI Wala

### Step 1: Files Replace Karo
Apne local `tax-rocket` folder me ye 10 files workspace se copy karo (LATE_FILER_FIX_INSTRUCTIONS.md me list hai).

### Step 2: Install & Run
```bash
cd tax-rocket
npm install
# agar .env nahi hai to banao (README se)
# DATABASE_URL, NEXTAUTH_SECRET etc

npx prisma generate
npx prisma migrate deploy  # ya dev agar local DB nahi

npm run dev
```
Open: http://localhost:3000

### Step 3: UI Check - 3 Buttons Dikhne Chahiye
1. Login with Google
2. New Filing -> Tax Year 2026 select karo
3. Income Sources me kuch bhi select karo e.g., `Bank Profit`
4. Subcategories me `bank-or-financial-institution-deposit` select karo
5. Bank Accounts add karo (e.g., HBL - Account 1)
6. Documents upload skip kar sakte ho testing ke liye, ya dummy CNIC upload karo
7. Bank Intelligence me statement save karo (opening 0, closing 1000000)
8. Ledger me entry add karo:
   - Type: INCOME
   - Category: BANK_PROFIT
   - Amount: 1000000
   - Description: Test profit
9. Reconciliation -> Auto -> Confirm
10. **Review Step pe jao:**

**Pehle 2 buttons the, ab 3 hone chahiye:**
```
[Calculate for ATL] [Calculate for Late Filer] [Calculate for Non-ATL]
```
Grid 3 columns me hona chahiye.

### Step 4: Calculation Test - Bank Profit (Fallback Logic)

**Test 1: ATL**
- Click `Calculate for ATL`
- Expected: Tax = 1,000,000 * 20% = **200,000**
- Badge dikhega: "Calculated for ATL"
- Breakdown me: `bank_profit: 20%`

**Test 2: Late Filer (Fallback to ATL)**
- Click `Calculate for Late Filer`
- Expected: Tax = 1,000,000 * 20% = **200,000** (same as ATL, kyunki bank profit me Late rate nahi hai PDF me)
- Badge: "Calculated for LATE_FILER"
- Ye fallback logic sahi hai - late filer filer hai, non-filer nahi

**Test 3: Non-ATL**
- Click `Calculate for Non-ATL`
- Expected: Tax = 1,000,000 * 40% = **400,000**

Agar teeno me ye numbers aaye to fix sahi hai!

### Step 5: Property Wala Test (Real Late Filer Rate)

**Note:** Advance Tax routes abhi calculate nahi hote (FLAT_ROUTE_DEFINITIONS me nahi), isliye ye test direct code se karna padega. Lekin jab advance_tax implement hoga tab:

- Property Transfer 50M:
  - ATL: 4.5% = 22.5L
  - LATE_FILER: 7.5% = 37.5L
  - NON_ATL: 11.5% = 57.5L

Iska code test neeche diya hai.

---

## Code Test (2 min) - Bina UI Ke

Local me ek file banao `test-late-filer.ts` project root pe:

```ts
import { calculateTaxEstimate } from './lib/tax/tax-calculation';
import { parseManualTaxpayerListStatus } from './lib/tax/tax-data-model';
import { getTy2026RateCardRule } from './lib/tax/rules/ty2026/catalog';

console.log("=== Parse Test ===");
console.log("ATL:", parseManualTaxpayerListStatus("ATL")); // ATL
console.log("LATE_FILER:", parseManualTaxpayerListStatus("LATE_FILER")); // LATE_FILER - pehle null tha
console.log("NON_ATL:", parseManualTaxpayerListStatus("NON_ATL")); // NON_ATL
console.log("INVALID:", parseManualTaxpayerListStatus("INVALID")); // null

console.log("\n=== Bank Profit Fallback Test ===");
const baseInput = {
  taxYear: 2026,
  totalIncome: 1000000,
  totalExpenses: 0,
  isSalariedRoute: false,
  isBankProfitRoute: true,
  incomeSources: [{ route: 'bank_profit' as const, income: 1000000, subcategory: 'bank-or-financial-institution-deposit' }]
};

const atl = calculateTaxEstimate({ ...baseInput, filerStatus: 'ATL' });
const late = calculateTaxEstimate({ ...baseInput, filerStatus: 'LATE_FILER' });
const nonAtl = calculateTaxEstimate({ ...baseInput, filerStatus: 'NON_ATL' });

console.log(`ATL: ${atl.taxDue} (expected 200000) - ${atl.status}`);
console.log(`LATE_FILER: ${late.taxDue} (expected 200000 fallback) - ${late.status}`);
console.log(`NON_ATL: ${nonAtl.taxDue} (expected 400000) - ${nonAtl.status}`);

if (atl.taxDue === 200000 && late.taxDue === 200000 && nonAtl.taxDue === 400000) {
  console.log("✅ Fallback logic PASS");
} else {
  console.log("❌ FAIL");
}

console.log("\n=== 236C Property Rates Check ===");
const rule = getTy2026RateCardRule('TY2026-236C-PROPERTY-TRANSFER-UP-TO-50M');
console.log("Rule ID:", rule?.id);
console.log("ATL:", rule?.rates.ATL);
console.log("LATE_FILER:", rule?.rates.LATE_FILER);
console.log("NON_ATL:", rule?.rates.NON_ATL);

console.log("\n=== All Good ===");
```

Run karo:
```bash
npx tsx test-late-filer.ts
```

Expected output:
```
ATL: ATL
LATE_FILER: LATE_FILER
NON_ATL: NON_ATL
ATL: 200000
LATE_FILER: 200000
NON_ATL: 400000
✅ Fallback logic PASS
236C Rule: ATL 4.5%, LATE 7.5%, NON 11.5%
```

---

## Database Wala Test (Agar DB Setup Hai)

```bash
# Prisma Studio kholo
npx prisma studio
```

- `FilingDraft` table me `taxpayerListStatus` column dekho
- Pehle sirf ATL/NON_ATL save hota tha, ab LATE_FILER bhi save hona chahiye
- Calculate ke baad `taxCalculationStatus` = ESTIMATE aur `taxpayerListStatus` = LATE_FILER dikhega

---

## Common Issues

**1. Buttons abhi bhi 2 dikh rahe hain:**
- `wizard-review-step.tsx` sahi replace nahi hua
- Browser cache clear karo (Ctrl+Shift+R)
- `grid-cols-3` class check karo

**2. `parseManualTaxpayerListStatus` null return kar raha hai Late Filer pe:**
- `lib/tax/tax-data-model.ts` replace nahi hua

**3. Late Filer pe tax 0 ya error:**
- `lib/tax/tax-calculation.ts` me `selectStatusRate` ka fallback logic check karo

**4. TypeScript errors:**
```bash
npx tsc --noEmit
# 0 errors hone chahiye
```

---

## Next Steps After Test Pass

1. Git commit karo:
```bash
git add lib/tax/tax-data-model.ts lib/tax/tax-calculation.ts components/tax/filing/wizard-review-step.tsx components/tax/filing/hooks/use-filing-finalization.ts components/tax/filing/config/filing-wizard-config.ts components/tax/filing/filing-wizard.tsx app/actions/tax-calculation.ts app/actions/fbr.ts app/actions/filing.ts app/actions/packet.ts
git commit -m "feat: add LATE_FILER support with ATL fallback for 236C/K"
```

2. Client meeting me Q8 ka answer le lo (Late Filer definition)
3. Agla fix: Withholding duplicate wala

---

## Video Demo Ke Liye Steps

Agar client ko dikhana hai to:

1. Screen record karo
2. Review step pe 3 buttons dikhao
3. ATL click -> 200k tax
4. Late Filer click -> 200k (fallback)
5. Non-ATL click -> 400k
6. Explain karo: "Property wale cases me Late ka alag rate lagega 7.5% vs ATL 4.5%"
