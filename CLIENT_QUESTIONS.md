# Client Confirmation Required - Pending Questions

> Sirf woh sawal jo client se confirm kiye bina fix nahi ho sakte.
> Fix jo hum khud kar sakte hain (late filer button, withholding filter, history etc) is file me nahi - wo hum direct fix karenge.

Last Updated: 2026-08-24

---

## 🔴 CRITICAL - Calculation Rok Rahe Hain (10 Lakh+ ka farq)

### Q1: Salary + Individual Rent - Ek Slab Ya Do Alag?
**Context:** Dono progressive hain (rising slab). WHT Rate Card sirf deduction at source batata hai, assessment ka rule nahi deta.

**Sawal:** Agar kisi ki salary bhi hai aur zaati property ka rent bhi, to Section 149 ka slab dono ki combined income par lagega ya har ek apna alag slab parhega?

**Money Impact:**
- Alag alag slab: Tax 28,36,000
- Combined ek slab: Tax 38,85,290
- **Farq: 10,49,290**

**Current:** NEEDS_RULES return hota hai, filing ruk jati hai.

---

### Q2: 1 Crore Surcharge Threshold - Combined Ya Sirf Salary?
**Context:** 9% surcharge 1 crore se upar lagta hai (Section 149 + 4AB).

**Sawal:** Ye 1 crore ki had sirf salary par dekhi jayegi ya sab income mila kar? Example: Salary 80L + Rent 40L = 1.2Cr. Alag dekhein to koi bhi 1Cr se upar nahi, combined dekhein to surcharge lagega.

**Note:** Q1 ke saath hal ho sakta hai, lekin jawab alag bhi ho sakta hai (slab alag, threshold combined).

---

### Q3: Salary + Pension Ek Saath - Combined Ya Alag?
**Context:** Dono progressive hain.

**Sawal:** Pension + Salary ek saath ho to combined slab ya alag? Aur ek catalog row hai "pension lene wala purane employer ke saath kaam jaari rakhe" to kya poori pension salary ki tarah Section 149 par lagegi?

---

### Q4: Section 155 Rental Tax - Adjustable Hai Ya Final?
**Context:** Property rent par jo WHT kata, wo final tax hai (refund nahi) ya adjustable (refund ban sakta hai)?

**Current:** Humne adjustable mana hai (safe side) taake refund claim na mare.

**Sawal:** Rental WHT ko final manna hai ya adjustable? Isse refund ka number direct change hota hai.

---

### Q5: Services, Prize/Commission, Capital Gains, Business - Final Ya Adjustable?
**Context:** Sirf Section 151 (bank profit) ko humne final mana hai, baqi sab adjustable.

**Sawal:** Section 153 (services), 156/233 (prize/commission), 151A (capital gains), business income - ye final hain ya adjustable? Agar galat final keh diya to client ka refund mar jayega.

---

### Q6: Pension Age Check - Kis Din Ki Age Dekhni Hai?
**Context:** Pension 10M se upar ho to rate is baat par hai ke pensioner 70 saal se kam hai ya nahi. PDF me date nahi likhi.

**Sawal:** Age kis din wali dekhein? Tax year ke aakhri din (30 June) wali ya jis din pension mili us din wali? Agar koi beech saal me 70 ka ho jaye to kya karna hai?

**Current:** Humne tax year end wali rakhi hai.

---

### Q7: Pension Above 10M Age 70+ Ka Kya Karna Hai?
**Context:** PDF Page 2: "Where the amount exceeds Rs. 10M Age below 70 years 5% + surcharge". Age 70+ ka zikr nahi.

**Sawal:** Agar pensioner 70+ hai aur pension 15M hai to tax kya lagega? Same 5% ya exempt ya alag?

**Current:** NEEDS_RULES return hota hai.

---

## 🟡 HIGH - Feature Ruk Raha Hai

### Q8: Late Filer Ka Definition Aur Fallback Rate?
**Context:** PDF me 236C (property transfer) aur 236K (purchase) me 3 rates: ATL 4.5%, Late 7.5%, Non-ATL 11.5%. Baqi sections me Late Filer column nahi.

**Sawal:**
1. Late Filer ka exact definition kya hai aapke system me? (Due date ke baad file kiya lekin ATL me aane se pehle?)
2. Jahan PDF me Late Filer rate nahi (e.g., bank profit, salary), wahan kaunsa rate use karein? ATL wala ya Non-ATL wala?

---

### Q9: Withholding Duplicate - Certificate vs Bank Ledger
**Context:** Salary certificate pe 2L WHT hai, bank statement me bhi "Salary Tax 2L" debit hai. Ye ek hi deduction hai ya do alag?

**Sawal:** FBR practice kya hai? Bank ki salary tax entry ko certificate ka payment proof samjhein (ek baar count) ya alag advance tax (do baar count)? Isse fake refund ka risk hai.

---

### Q10: Mutual Fund Dividend - Debt/Equity Split Kahan Se?
**Context:** PDF: Mutual fund dividend proportional - debt portion 25%, equity 15% (Non-ATL 50%/30%). Ledger me single amount hai, split nahi.

**Sawal:** Ye split kahan se milta hai? Dividend certificate par likha hota hai ya user khud daalega? Default rule hai?

**Current:** Calculation ruk jata hai NEEDS_RULES ke saath.

---

### Q11: Sukuk Exactly 10 Lakh Pe Kaunsa Rate?
**Context:** PDF: Sukuk individual/AOP >10L = 12.5%, <10L = 10%. Exactly 10L ka zikr nahi.

**Sawal:** Theek 10,00,000 pe kaunsa rate lagega - 12.5% ya 10%?

---

### Q12: Imports - Calculation Aur Card Banana Hai?
**Context:** 10 rules catalog me hain (Part-I 1%, Part-II 2%, etc) lekin calculation nahi lagi aur wizard me card bhi nahi.

**Sawal:** Imports ki calculation laga kar wizard card add kar dein? Ye income hai ya withholding?

---

### Q13: Advance Tax (65 Rules) - Track Karna Hai?
**Context:** Catalog me 65 rules hain jo income nahi, pehle se diya hua tax hai: motor vehicle (23 rules), electricity (6), property purchase/sale (6), telephone, auction, cash withdrawal, etc.

**Sawal:** Kya app ko advance tax bhi track karna chahiye? Ye refund/payable ko affect karta hai. Agar haan to ye "income" ki tarah nahi balke "pre-paid tax" ki tarah dikhna chahiye - alag feature hai.

**Note:** Ye Q12 se alag hai - Q12 imports (income side), Q13 advance tax (pre-paid side).

---

### Q14: Mobile Phone Import Bands - Detailed Table Kahan Se?
**Context:** PDF Page 1: PCT 8517.1219 mobile phones Rs 70 to 11,500 range deta hai, lekin actual value bands nahi.

**Sawal:** Detailed mobile phone band table kis document me hai? FBR SRO me?

---

### Q15: Empty Tiles - Agriculture, AOP/Company Links, Sales Tax/FED
**Context:** Wizard me 3 tiles hain jinke WHT Rate Card me 0 rules: agriculture, aop_company_links, sales_tax_fed_withholding.

**Sawal:** Inka kya karein? (a) Rules kisi aur source (Ordinance) se lein, (b) Wizard se hata dein, (c) Rakhein lekin "abhi available nahi" dikhayein?

---

### Q16: Unknown Ledger Category - Salary Me Daalein Ya Rokein?
**Context:** Agar ledger category PDF me nahi (e.g., IMPORTS, FREELANCE typo), to kya usko salary samajh ke 35% tax lagayein ya user ko sahi map karne ko kahein?

**Sawal:** Fallback salary karna hai ya NEEDS_RULES ke saath block karna hai?

---

## ✅ Already Verified - Client Se Puchne Ki Zaroorat Nahi

- Surcharge calculated tax par lagta hai (9% salary, 10% pension) - PDF Page 2 + client ne confirm kiya tha. Code sahi hai.
- Business 3 rows (236G fertilizer 0.25%/0.70%, 236G other 0.10%/2%, 236H 0.50%/2.50%) Non-ATL double nahi - ye PDF ka behaviour hai, sahi hai.
- Bank profit final tax, baqi adjustable - safe default hai, lekin Q5 me final confirmation pending hai.

---

## Chhota Version (Client Ko Bhejne Ke Liye)

> 1. Salary + rent ho to slab combined ya alag? (10.5L ka farq)
> 2. 1Cr surcharge threshold combined ya sirf salary?
> 3. Salary + pension combined ya alag? Aur purane employer case me?
> 4. Rental tax (155) adjustable ya final?
> 5. Services, prize, capital gains, business - final ya adjustable?
> 6. Pension age check kis date pe?
> 7. Pension 10M+ age 70+ ka tax kya?
> 8. Late Filer definition aur jahan rate nahi wahan kaunsa fallback?
> 9. Salary certificate vs bank salary tax entry - ek baar ya do baar count?
> 10. Mutual fund dividend debt/equity split kahan se?
> 11. Sukuk exactly 10L pe kaunsa rate?
> 12. Imports calculation + card banana hai?
> 13. Advance tax (vehicle, electricity, property) track karna hai?
> 14. Mobile import bands ki detailed table kahan se?
> 15. Agriculture, AOP, Sales Tax tiles ka kya karein?
> 16. Unknown category ko salary samjhein ya rokein?
