// Supabase Edge Function: notify
// Sends the queued portal emails (table public.notifications) through Microsoft Graph.
// The portal calls this after each action; it only ever sends what is already queued,
// so calling it repeatedly can't create extra emails.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   Graph app (needs Mail.Send application permission)
//   MAIL_SENDER    mailbox the app sends as, e.g. ap-portal@flexo.com.ph
//   AP_EMAIL       Accounting's shared mailbox (new sign-ups and invoices)
//   PORTAL_URL     https://fmcai70.github.io/FlexoSupplier/
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const env = (k: string) => Deno.env.get(k) ?? "";
const PORTAL_URL = env("PORTAL_URL") || "https://fmcai70.github.io/FlexoSupplier/";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- Microsoft Graph ----------
let token: { value: string; exp: number } | null = null;
async function graphToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env("MS_CLIENT_ID"),
      client_secret: env("MS_CLIENT_SECRET"),
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Graph token: ${j.error_description ?? j.error ?? res.status}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return token.value;
}
async function sendMail(to: string, subject: string, html: string) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env("MAIL_SENDER"))}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await graphToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---------- email content ----------
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const peso = (v: unknown) => "₱ " + Number(v ?? 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (s: unknown, weekday = false) => s ? new Date(String(s).slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", ...(weekday ? { weekday: "long" as const } : {}) }) : "—";
function layout(title: string, intro: string, rows: [string, string][], button: string, footer = "") {
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#15232B;max-width:560px">
  <div style="border-bottom:3px solid #0E6B5C;padding:8px 0 10px;margin-bottom:16px"><b style="color:#0E6B5C">Flexo Manufacturing Corporation</b> · Supplier Invoice Portal</div>
  <h2 style="font-size:18px;margin:0 0 8px">${esc(title)}</h2>
  <p style="margin:0 0 14px">${intro}</p>
  ${rows.length ? `<table style="border-collapse:collapse;margin:0 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#6B7A80">${esc(k)}</td><td style="padding:4px 0"><b>${v}</b></td></tr>`).join("")}</table>` : ""}
  <p style="margin:0 0 16px"><a href="${esc(PORTAL_URL)}" style="background:#0E6B5C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;display:inline-block">${esc(button)}</a></p>
  ${footer ? `<p style="margin:0 0 8px">${footer}</p>` : ""}
  <p style="color:#6B7A80;font-size:12px;margin:16px 0 0">This is an automatic message from the Flexo Supplier Invoice Portal. Please do not reply.</p></div>`;
}
type Row = { id: number; kind: string; invoice: Record<string, any> | null; profile: Record<string, any> | null };
export function compose(n: Row): { to: string; subject: string; html: string } | null {
  const p = n.profile ?? {}, i = n.invoice ?? {};
  const inv: [string, string][] = [["Invoice no.", esc(i.invoice_no)], ["Invoice date", day(i.invoice_date)], ["PO no.", esc(i.po_no)], ["DR no.", esc(i.dr_no)], ["Total amount", peso(i.total_amount)]];
  const ap = env("AP_EMAIL");
  switch (n.kind) {
    case "signup":
      return ap ? { to: ap, subject: `New supplier sign-up: ${p.company_name}`, html: layout("New supplier sign-up — approval needed",
        "A supplier signed up on the portal and is waiting for approval. Check the details, then approve the account with the supplier's SAP vendor code under <b>Supplier accounts</b>.",
        [["Company", esc(p.company_name)], ["TIN", esc(p.tin)], ["Contact", esc(p.contact_name)], ["Email", esc(p.email)], ["Phone", esc(p.phone)]], "Open Supplier accounts") } : null;
    case "account_approved":
      return { to: p.email, subject: "Your Flexo supplier portal account is approved", html: layout("Your account is approved",
        `Hello ${esc(p.contact_name || p.company_name)}, your account for <b>${esc(p.company_name)}</b> has been approved. You can now submit your invoices to Flexo online.`,
        [["Vendor code", esc(p.vendor_code)]], "Sign in and submit an invoice") };
    case "account_rejected":
      return { to: p.email, subject: "Your Flexo supplier portal sign-up", html: layout("Your sign-up was not approved",
        `Hello ${esc(p.contact_name || p.company_name)}, Flexo Accounting could not approve the portal account for <b>${esc(p.company_name)}</b>.`,
        p.status_note ? [["Reason", esc(p.status_note)]] : [], "Open the portal", "If you think this is a mistake, please contact Flexo Accounting.") };
    case "invoice_submitted":
      return ap ? { to: ap, subject: `New invoice ${i.invoice_no} from ${i.company_name}`, html: layout("New invoice submitted",
        `<b>${esc(i.company_name)}</b> (${esc(i.vendor_code)}) submitted an invoice for review.`,
        [...inv, ["VAT-exclusive", peso(i.vatex_amount)]], "Review in the portal") } : null;
    case "invoice_returned":
      return { to: p.email, subject: `Invoice ${i.invoice_no} was returned — action needed`, html: layout("Your invoice was returned",
        `Flexo Accounting returned invoice <b>${esc(i.invoice_no)}</b>. Please correct it and submit it again in the portal.`,
        [["Reason", esc(i.return_reason)], ...inv], "Open My invoices") };
    case "invoice_scheduled":
    case "invoice_rescheduled":
      if (i.status !== "scheduled") return null; // unscheduled, returned or already paid since then
      return { to: p.email, subject: `${n.kind === "invoice_rescheduled" ? "Updated: " : ""}Payment scheduled for invoice ${i.invoice_no} — ${day(i.release_date, true)}`,
        html: layout(n.kind === "invoice_rescheduled" ? "Your payment schedule was updated" : "Your payment is scheduled",
        `Payment for invoice <b>${esc(i.invoice_no)}</b> is scheduled for check release on <b>${day(i.release_date, true)}</b>.`,
        [["Check release", day(i.release_date, true)], ["Amount to be released", peso(i.release_amount)], ...(i.release_note ? [["Note", esc(i.release_note)] as [string, string]] : []), ...inv], "View in My invoices") };
    case "invoice_paid":
      return { to: p.email, subject: `Invoice ${i.invoice_no} has been paid`, html: layout("Your invoice has been paid",
        `Flexo has paid invoice <b>${esc(i.invoice_no)}</b>. The proof of payment is available in the portal under <b>My invoices</b>.`,
        [["Paid on", day(i.paid_date)], ["Amount", peso(i.release_amount ?? i.total_amount)], ["Check / ref. no.", esc(i.payment_ref)], ...inv], "View proof of payment") };
    default:
      return null;
  }
}

// ---------- send the queue ----------
export async function flush() {
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
  const { data, error } = await db.rpc("claim_notifications", { p_limit: 25 });
  if (error) throw new Error(`claim: ${error.message}`);
  let sent = 0, failed = 0, skipped = 0;
  const rows = (data ?? []) as Row[];
  const sched = (k: string) => k === "invoice_scheduled" || k === "invoice_rescheduled";
  for (const [k, n] of rows.entries()) {
    let err: string | null = null;
    try {
      // several schedule changes for one invoice in this batch → only the last one is emailed
      const superseded = sched(n.kind) && rows.slice(k + 1).some((m) => sched(m.kind) && m.invoice?.id === n.invoice?.id);
      const mail = superseded ? null : compose(n);
      if (mail && mail.to) { await sendMail(mail.to, mail.subject, mail.html); sent++; } else skipped++;
    } catch (e) { err = String((e as Error).message ?? e).slice(0, 500); failed++; }
    await db.rpc("finish_notification", { p_id: n.id, p_error: err });
  }
  return { sent, failed, skipped };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    try {
      const r = await flush();
      return new Response(JSON.stringify(r), { headers: { ...cors, "Content-Type": "application/json" } });
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }
  });
}
