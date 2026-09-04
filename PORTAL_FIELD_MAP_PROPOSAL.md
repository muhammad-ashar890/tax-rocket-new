# Portal Field Map Proposal - IRIS Codes -> TaxRocket Categories

This file proposes how our filing data should be mapped to IRIS portal field codes from `IRIS_System_Field_Codes_Extracted.csv`

## Proposed `portalFieldMap` Structure for Packet Snapshot

```json
{
  "version": "1.0",
  "taxYear": "2026",
  "generatedAt": "2026-05-11T...",
  "fieldMappings": [
    {
      "ourCategory": "SALARY",
      "ourAmount": 3000000,
      "irisPortalArea": "Employment",
      "irisSection": "Salary",
      "irisField": "Income from Salary",
      "systemCode": "1000",
      "column": "Amount Subject to Normal Tax",
      "source": "ledgerEntries[0]"
    }
  ],
  "adjustableTaxMappings": [
    {
      "ourCategory": "SALARY",
      "taxDeducted": 200000,
      "systemCode": "64020004",
      "description": "Salary of Employees u/s 149"
    }
  ]
}
```

---

## Category -> IRIS System Code Mapping (Draft v1)

### 1. SALARY (Sec 12)
**Our data:** salary_certificate.pdf 30L income, 2L tax u/s 149

| Our Field | IRIS Description | System Code | Portal_Area | Section |
|-----------|------------------|-------------|-------------|---------|
| gross salary | Income from Salary | 1000 | Employment | Salary |
| pay/wages | Pay, Wages or Other Remuneration | 1009 | Employment | Salary |
| allowances | Allowances | 1049 | Employment | Salary |
| pension (if salary pension) | Pension / Annuity u/s 12(2)(f) | 1008 | Employment | Salary |
| tax withheld | Salary u/s 149 | 64020004 | Tax Chargeable / Payments | Adjustable Tax |

### 2. PENSION (Exempt vs Taxable)
**Our data:** pension_statement_15M_below70.pdf 15M, taxable 5M

| Scenario | IRIS Field | Code |
|----------|------------|------|
| Govt pension exempt (<70 10M, >70 15M) | Income from Salary exempt OR Annuity/Pension | 1008 / 5007 |
| Pension taxable above limit | Annuity / Pension (Other Sources) | 5007 |
| Tax on pension | Salary u/s 149 | 64020004 |

*Note: IRIS has no separate pension exemption code - it's handled in computation via exempt amount column*

### 3. BANK_PROFIT / Profit on Debt
**Our data:** bank_statement 10L profit

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Receipt | Profit on Debt | 500312 |
| Tax | Profit on Debt u/s 151(1)(b) Bank @15% | 64040002 |
| If NSC | Profit on Debt u/s 151(1)(a) NSC @15% | 64040001 |
| If Govt Securities | Profit on Debt u/s 151(1)(c) | 64040003 |

### 4. RENT / Property Income
**Our data:** rent_agreement 15L rent

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Rent Received | Rent Received or Receivable | 2001 |
| Total Receipts | Total Receipts from Property | 2029 |
| Income/Loss | Income/(Loss) from Property | 2000 |
| Repair 1/5th | 1/5th of Rent for Repairs | 2031 |
| Tax withheld | Rent u/s 155 | 64080001 |
| If commercial tenant tax | Tax on Rent of Property? | 641000?? |

### 5. DIVIDEND
**Our data:** dividend_certificate 5L dividend

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Dividend income | Likely under Other Sources or separate? Check if in CSV: Not directly, but Adjustable Tax has dividend codes? Search: 6403xxxx | Need to search dividend in CSV |
| Tax | Dividend u/s 150 | 640300?? |

*Gap: Dividend codes not clearly in this CSV extract - need to search full IRIS*

### 6. BUSINESS / Freelance
**Our data:** business_books.pdf, invoice_summary.pdf

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Net profit before adjustments | Income/Loss before adjustment | 3270 |
| Addition | Addition to Income | 3260 |
| Assets | Total Assets | 3349 |
| Sales/Goods | Relevant 6406xxxx codes | 64060002 etc |
| Tax withheld | Payment for Goods/Services | 64050007 etc |

### 7. CAPITAL GAINS (CGT)
**Our data:** cgt_statement.pdf

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Total gains | Gains/(Loss) from Capital Assets | 4000 |
| Long term disposal | Consideration Long Term | 4006 |
| Long term cost | Cost Long Term | 4016 |
| Long term net | Net Gain Long Term | 4017 |
| Short term | Consideration Short Term | 4026 |
| Short term cost | Cost Short Term | 4036 |
| Short term net | Net Gain Short Term | 4037 |

### 8. OTHER INCOME
**Our data:** other_income_proof.pdf

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Other receipts | Other Receipts | 5028 |
| Total other | Receipts from Other Sources | 5029 |
| Income/loss | Income/(Loss) from Other Sources | 5000 |

### 9. FOREIGN / AGRICULTURE
**Our data:** foreign_asset_statement.pdf, agri_record.pdf

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Agri income | Agriculture Income | 6100 |
| Foreign income | Foreign Income | 6000 |
| Foreign salary | Foreign Salary Income | 6011 |
| Foreign property | Foreign Property Income | 6029 |
| Foreign business | Foreign Business Income | 6039 |
| Foreign capital | Foreign Capital Gains | 6049 |

### 10. ADJUSTABLE TAXES - 236C / 236K Property (CRITICAL for Late Filer fix)
**Our data:** advance_tax_evidence.pdf 50M property

| Our Field | IRIS Description | Code |
|-----------|------------------|------|
| Sale/Transfer 236C | Sale/Transfer of Immovable Property u/s 236C | 64150301 |
| Purchase 236K | Purchase/Transfer of Immovable Property u/s 236K | 64151101 |
| Advance tax general | Adjustable Tax | 640000 |
| Import | Import u/s 148 @1% | 64010002 |

**Our Late Filer Fix Logic:**
- 50M property, ATL 4.5% = 2.25M, Late 7.5% = 3.75M, Non 11.5% = 5.75M
- If we map to 64150301 + 64151101, IRIS will calculate accordingly
- Need to ensure our WHT Rate Card mapping uses these exact codes

### 11. COMPUTATIONS (Auto-calculated by IRIS)
**These are NOT filled by agent, IRIS calculates:**

| Description | Code |
|-------------|------|
| Total Income | 9000? (need check) |
| Taxable Income | 9100 |
| Tax Chargeable | 9200 |
| Surcharge | 923184 (from earlier file) |
| Tax on deemed income 7E | 923183 |

### 12. WEALTH STATEMENT (116)
**Our data:** foreign_asset_statement, bank_statement

| Description | Code |
|-------------|------|
| Agricultural Property | 7001 |
| Non-Business Property | 7002 |
| Business Capital | 7003 |
| Investment | 7006 |
| Motor Vehicle | 7008 |
| Cash | 7012 |
| Total Assets | 7015 etc |

---

## Implementation in Packet Generation

**Current `app/actions/packet.ts` does:**
```ts
snapshot: {
  filing: {...},
  documents: [...],
  ledgerEntries: [...]
}
```

**Should be:**
```ts
snapshot: {
  filing: {...},
  documents: [...],
  ledgerEntries: [...],
  portalFieldMap: {
    version: "1.0",
    incomeFields: [
      { ledgerEntryId, systemCode: "1000", column: "Amount Subject to Normal Tax", amount: 3000000 },
      { ledgerEntryId, systemCode: "1009", column: "Total Amount", amount: 3000000 },
      ...
    ],
    adjustableTaxFields: [
      { ledgerEntryId, systemCode: "64020004", amount: 200000 },
      { ledgerEntryId, systemCode: "64150301", amount: 2250000, propertyValue: 50000000, filerStatus: "ATL" },
      ...
    ],
    wealthFields: [...],
    computationHints: {
      salaryExemptPension: 10000000, // for <70
      totalIncome: ...,
      taxableIncome: ...
    }
  },
  irisSelectors: {
    // Reference to selector bundle version
    bundleVersion: "v1.0-2026-05-11",
    portalType: "IRIS_2_0" // or "CLASSIC"
  }
}
```

**Electron Agent will then:**
1. Load context: `GET /api/local-agent/jobs/{jobId}/context`
2. Get portalFieldMap
3. For each field, find IRIS DOM element by systemCode or field description
4. Fill amount
5. Capture screenshot
6. Pause at gates if needed

---

## Missing Codes to Clarify with Client

1. Dividend income - code not in this CSV? Should be 500? or 640300?
2. Salary exemptions - how to show exempt amount in IRIS column "Amount Exempt from Tax"?
3. Pension exemption - same, how to split exempt vs taxable in 1008 vs 5007?
4. Business expenses - which codes for Management Expenses etc?
5. Foreign tax credit - code?

Need to search full IRIS portal HTML or ask client for full field dump.
