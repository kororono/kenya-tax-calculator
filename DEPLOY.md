# Deploying & Using Mom's Kenya Tax & Daily Rate Web App (Google Apps Script)

You can use this app in **two ways**:
1. **Locally right now:** Double-click `index.html` in this folder to open it in Chrome/Edge on any laptop or phone. It saves calculations to local browser history immediately and exports CSVs or WhatsApp summaries.
2. **As a Shareable Google Link (+ Google Sheets Corrective Audit Ledger):** Deploy it on Google Apps Script in ~2 minutes following the steps below.

---

## 1. How to Deploy to Google Apps Script (Shareable Link)

1. Open [Google Sheets](https://sheets.new) to create a new blank spreadsheet, and name it **`Mom Tax Calculations Log (2026)`**.
2. In the top menu, click **Extensions → Apps Script**.
3. **Paste `Code.gs`:**
   - Select all the default code in `Code.gs` (`function myFunction() {}`), delete it, and paste the entire contents of `Code.gs` from this folder.
4. **Add `index.html`:**
   - Click the **`+`** icon next to **Files** (top-left sidebar) → select **HTML**.
   - Name the file **`index`** (Google automatically adds `.html`, so it becomes `index.html`).
   - Delete the starter HTML and paste the entire contents of `index.html` from this folder.
   - Press **Ctrl+S** (Save).
5. **Publish the Shareable Web Link:**
   - Click **Deploy** (top-right blue button) → **New deployment**.
   - Click the gear icon next to **Select type** → check **Web app**.
   - Set:
     - **Description:** `Mom Kenya Tax Calculator 2026`
     - **Execute as:** `Me`
     - **Who has access:** `Anyone` *(so your mom can open the link on her phone without a Google login wall)*
   - Click **Deploy**, approve the one-time Google permission prompt (**Advanced → Go to project (unsafe) → Allow**), and copy the **Web app URL** (`https://script.google.com/macros/s/.../exec`).

---

## 2. How Mistake Correction & Backward Compatibility Work

### A. Fixing a Past Saved Calculation (`Section 7: Saved Calculations History`)
- Every saved calculation gets a unique ID (e.g. `CALC-20261123-164000`) and stores a full snapshot of the months, Daughter days, Son days, and daily rates.
- If a mistake was recorded in an earlier calculation (wrong day count, wrong rate, or missed month):
  1. Scroll to **Section 7** and click **"Load & Correct"** on that past entry.
  2. The app reloads all of that calculation's exact months, days, and rates into the form, pre-fills **Amount Already Paid / Previously Billed** with the old Gross amount, and shows a live yellow **Correction Banner** at the top (`Old Gross → New Corrected Gross | Variance: +/- KES ...`).
  3. Fix the days/rate, type a short note in **Correction Note / Reason** (e.g., `"Fixed Sept days from 18 to 19"`), and click **"Save Corrected Calculation"**.
  4. In the Google Sheet (and local history), the old row is automatically marked **`SUPERSEDED BY CALC-...`** (so your historical audit trail is preserved), and the new row logs the exact **Net Balance / Shortfall Still Owed**.
- You can also click **"Void"** on any entry recorded by mistake to mark it `VOIDED` in the ledger.

### B. Reconciling Partial or Under-Calculated Prior Payments (`Section 3`)
- Even without loading a past row, your mom can type any amount the client already paid or was previously billed into **Amount Already Paid / Previously Billed (KES)** (and any manual carry-over into **Additional Prior Carry-Over Adjustment**).
- The app subtracts that from the **Correct Total Gross Invoice** and displays the exact **Net Balance / Shortfall Still Owed by Client** both on the summary card and at the bottom of the Payslip Proof table.
