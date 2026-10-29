# Flexo Supplier Invoice Portal

Suppliers sign up, Flexo Accounting approves them, and then they submit invoices online.
Each submission is 7 required fields plus the invoice file. Accounting checks each invoice,
schedules its check release for a Friday, and marks it paid with a proof of payment. The
supplier sees when they will be paid and how much, and can open the proof once it is paid.

| Piece | Where it runs |
|---|---|
| Web app (`public/`) | GitHub Pages (static hosting, deployed by GitHub Actions) |
| Accounts, database, file storage | Supabase (Auth + Postgres + Storage) |

`original/Flexo_Supplier_Invoice_Portal.html` is the first claude.ai prototype, kept for reference.

---

## How it works

```mermaid
flowchart LR
  SU[Supplier signs up] --> PEND[Pending approval]
  PEND -->|Accounting approves + sets SAP vendor code| SUB[Supplier submits invoice: 7 fields + file]
  SUB --> REV[For review]
  REV -->|Mark as OK| OK[Checked OK]
  OK -->|Schedule check release: Friday + amount| SCH[Scheduled]
  SCH -->|Mark paid: date, check no., proof of payment| PAID[Paid]
  REV -->|Return + reason| RET[Returned]
  OK -->|Return + reason| RET
  SCH -->|Return + reason| RET
  RET -->|Supplier corrects and resubmits| SUB
```

### Accounting steps
1. **For review → Mark as OK.** Check the typed values against the attached invoice and SAP.
2. **Checked OK → Schedule check release.** You can tick several invoices and click
   **Schedule selected** for a Friday, which releases the full total for each. Or you can open one
   invoice and set the **amount to be released** and a **note to the supplier**, for example
   *less 1% EWT*. The release date can only be a Friday. The amount can't be more than the invoice total.
   You can change or remove a schedule until the invoice is paid.
3. **Scheduled → Mark as paid.** Enter the payment date and check / reference no., and attach the
   **proof of payment** (PDF, JPG or PNG). Once paid, the invoice can't be changed any more.

The **Scheduled for release** list shows the total per Friday, which you can use for the check run.
Use **Export CSV** to download the list.

### What the supplier sees
- **My invoices** shows each invoice's status.
- Once scheduled, it shows the **check release date and amount**, with any note. A card at the top
  totals each upcoming Friday.
- Once paid, it shows the payment date and reference, and a **View proof of payment** button.

### Invoice fields (all required)
1. Invoice number
2. Invoice date
3. PO number
4. VAT-exclusive amount
5. Total amount (the VAT is calculated and shown as Total − VAT-exclusive)
6. DR (delivery receipt) number
7. DR date

The invoice file (PDF, JPG or PNG, up to 10 MB) is also required.

The form also rejects these entries: a future date, a total lower than the VAT-exclusive
amount, and an invoice number the same supplier has already submitted (unless the earlier
one was returned).

There is **no automatic matching against SAP**. Staff check each invoice against the
attached file and SAP before approving. To help them, the invoice detail shows a warning
when the VAT isn't about 12%, when the same DR number appears on another invoice, or when
the invoice number was used before.

### Roles
| Role | Can do |
|---|---|
| Supplier (pending) | Sign in and see "awaiting approval". Cannot submit |
| Supplier (approved) | Submit invoices, and see **only their own** invoices and files |
| Staff | See all invoices; mark OK, return, schedule check release, mark paid with proof; approve or reject supplier accounts and set their SAP vendor code; export CSV |
| Admin | Everything staff can do, and also make other accounts staff or admin |

These rules are enforced **by the database** (Supabase row-level security in
`supabase/schema.sql`), not just hidden in the screen. A supplier cannot read another
supplier's invoices or files, approve their own invoice, change an amount after
submitting, or make themselves staff. Every status change is written to a history log
that nobody can edit.

---

## Setup

### 1. Supabase database
1. In your Supabase project, open **SQL Editor**. Paste the whole of `supabase/schema.sql` and click **Run**.
   Run it again after every update to this file. It is safe to re-run and keeps your data.
   - If you used the earlier pilot version, this also locks its old open table (`docs`).
     Nothing is deleted. You can remove that table later with `drop table public.docs;`.
2. Go to **Authentication → Sign In / Providers → Email**:
   - Keep **Email** enabled.
   - **Turn OFF "Confirm email"** for now (see the email note below). Flexo's own approval step
     already confirms who each supplier is.
3. Go to **Authentication → URL Configuration**:
   - Set **Site URL** to `https://fmcai70.github.io/FlexoSupplier/`.
   - Add the same address under **Redirect URLs**.

### 2. Create the first admin
1. Open the portal and **Sign up** with your own Flexo email.
2. In the Supabase **SQL Editor**, run this with your own email:
   ```sql
   update public.profiles set role = 'admin', status = 'approved' where email = 'your.name@flexo.com.ph';
   ```
3. Sign out of the portal and sign in again. You'll see the **Invoices** and **Supplier accounts** tabs.

Other staff sign up the same way. An admin then sets their **Role** to `staff` and clicks **Approve**
under **Supplier accounts**.

### 3. Approve suppliers
Go to **Supplier accounts → Pending approval**. Check the company name, TIN and contact, then
type the supplier's **SAP vendor code** (CardCode) and click **Approve**. To refuse an account,
click **Reject** and give a reason, which the applicant will see.

### 4. GitHub Pages
This is already set up: the `SUPABASE_URL` and `SUPABASE_ANON_KEY` repository variables, Pages
source set to GitHub Actions, and the `github-pages` environment allowing `main`. Every push to
`main` redeploys the site.

### ✉️ Email (sign-up confirmation and password reset)
Supabase's built-in email only delivers to members of your Supabase team, so suppliers wouldn't
receive confirmation or "forgot password" emails. That's why "Confirm email" is off above. To turn
on password-reset emails for suppliers, add your own email sender under
**Authentication → Emails → SMTP Settings**. Your company Microsoft 365 mailbox, or a service such
as Brevo or Resend, will work. Until that is set up, password resets can't reach suppliers, so set up SMTP before inviting many suppliers.

### Local testing
```bash
cp public/config.example.js public/config.js   # fill in URL + anon key
npx http-server public -p 8080                 # open http://localhost:8080
```

---

## Files
| Path | What it is |
|---|---|
| `public/index.html`, `public/app.js`, `public/styles.css` | The portal |
| `supabase/schema.sql` | Tables, security rules, file storage, history log |
| `.github/workflows/deploy-pages.yml` | Publishes `public/` to GitHub Pages |
| `sap/*.sql` | SAP B1 export queries for POs and GRPOs. **Not used** by this version, which has no automatic matching. Kept for later |
