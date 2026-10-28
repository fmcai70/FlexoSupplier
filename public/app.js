// Flexo Supplier Invoice Portal — v2
// Suppliers sign up, Flexo approves them, then they submit invoices (7 fields + file).
// Flexo staff review each invoice and approve / return / mark it paid.
// Access rules are enforced by Supabase (see supabase/schema.sql); this file is the UI.
(() => {
"use strict";

// ---------- setup ----------
const cfg = window.FLEXO_CONFIG || {};
const BUCKET = "invoice-files";
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const SITE_URL = location.origin + location.pathname;

const S = {
  sb: null, session: null, profile: null, recovering: false,
  tab: null, authMode: "signin",
  invoices: [], profiles: [], loaded: { invoices: false, profiles: false },
  filter: "submitted", q: "", acctFilter: "pending",
  openId: null, lastSubmitted: null,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const x = parseFloat(String(v ?? "").replace(/[,\s₱]|PHP/gi, "")); return isFinite(x) ? x : null; };
const peso = v => v == null ? "—" : "₱ " + Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => { if (!s) return "—"; const d = new Date(String(s).length === 10 ? s + "T00:00:00" : s); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }); };
const fmtDT = s => { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? esc(s) : d.toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isStaff = () => S.profile && ["staff", "admin"].includes(S.profile.role) && S.profile.status === "approved";
const isAdmin = () => S.profile && S.profile.role === "admin" && S.profile.status === "approved";
const isSupplier = () => S.profile && S.profile.role === "supplier" && S.profile.status === "approved";

function toast(msg) {
  const r = $("#toastRoot");
  r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => (r.innerHTML = ""), 3600);
}
function friendly(err) {
  const m = (err && (err.message || err.error_description)) || String(err || "");
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first — check your inbox for the link.";
  if (/already registered|already been registered/i.test(m)) return "This email already has an account. Sign in instead, or use “Forgot password”.";
  if (/password should be at least/i.test(m)) return "Password must be at least 8 characters.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Wait a few minutes and try again.";
  if (/invoices_no_duplicates|duplicate key/i.test(m)) return "You already submitted an invoice with this number.";
  if (/failed to fetch|network/i.test(m)) return "Can't reach the server. Check your internet connection.";
  return m || "Something went wrong. Please try again.";
}

const STATUS = {
  submitted: { label: "Submitted — for review", sup: "Received — under review", cls: "p-submitted" },
  approved: { label: "Approved for payment", sup: "Approved for payment", cls: "p-approved" },
  returned: { label: "Returned to supplier", sup: "Returned — see reason", cls: "p-returned" },
  paid: { label: "Paid", sup: "Paid", cls: "p-paid" },
};
const pill = (st, supplierView) => { const x = STATUS[st] || STATUS.submitted; return `<span class="pill ${x.cls}">${esc(supplierView ? x.sup : x.label)}</span>`; };
const ACCT = {
  pending: { label: "Pending approval", cls: "p-pending" },
  approved: { label: "Approved", cls: "p-ready" },
  rejected: { label: "Rejected", cls: "p-rejected" },
  disabled: { label: "Disabled", cls: "p-disabled" },
};
const acctPill = st => { const x = ACCT[st] || ACCT.pending; return `<span class="pill ${x.cls}">${x.label}</span>`; };

// ---------- boot ----------
async function boot() {
  // Use only https://<ref>.supabase.co — ignore any extra path (e.g. "/rest/v1/") or spaces pasted with it.
  let baseUrl = null;
  try { baseUrl = new URL(String(cfg.supabaseUrl || "").trim()).origin; } catch (e) {}
  const anonKey = String(cfg.supabaseAnonKey || "").trim();
  if (!baseUrl || !anonKey || !window.supabase) {
    $("#app").innerHTML = `<div class="auth panel"><div class="panel-b"><h2>Portal unavailable</h2><p class="muted">The portal can't reach its database. IT: check config.js (Supabase URL and anon key).</p></div></div>`;
    return;
  }
  S.sb = window.supabase.createClient(baseUrl, anonKey);
  S.sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") S.recovering = true;
    const changed = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (changed) { S.profile = null; S.tab = null; S.invoices = []; S.profiles = []; S.loaded = { invoices: false, profiles: false }; S.openId = null; setTimeout(loadProfile, 0); }
    else render();
  });
  // onAuthStateChange fires INITIAL_SESSION right away, which loads the profile.
}

async function loadProfile() {
  if (!S.session) { S.profile = null; render(); return; }
  for (let i = 0; i < 3; i++) {
    const { data, error } = await S.sb.from("profiles").select("*").eq("id", S.session.user.id).maybeSingle();
    if (error) { toast(friendly(error)); break; }
    if (data) { S.profile = data; break; }
    await new Promise(r => setTimeout(r, 700)); // profile row is created right after sign-up
  }
  render();
  if (isSupplier() || isStaff()) loadInvoices();
  if (isStaff()) loadProfiles();
}
async function loadInvoices() {
  const { data, error } = await S.sb.from("invoices").select("*").order("created_at", { ascending: false }).limit(2000);
  if (error) toast(friendly(error)); else S.invoices = data || [];
  S.loaded.invoices = true; render();
}
async function loadProfiles() {
  const { data, error } = await S.sb.from("profiles").select("*").order("created_at", { ascending: false }).limit(2000);
  if (error) toast(friendly(error)); else S.profiles = data || [];
  S.loaded.profiles = true; render();
}

// ---------- shell ----------
function render() {
  renderWho();
  const app = $("#app");
  if (S.recovering && S.session) { renderTabs([]); app.innerHTML = resetView(); bindReset(); return; }
  if (!S.session) { renderTabs([]); app.innerHTML = authView(); bindAuth(); renderDrawer(); return; }
  if (!S.profile) { renderTabs([]); app.innerHTML = `<div class="empty" style="padding-top:80px"><div class="spinner" style="margin:0 auto 10px"></div>Loading your account…</div>`; return; }
  if (!isSupplier() && !isStaff()) { renderTabs([]); app.innerHTML = notApprovedView(); bindNotApproved(); return; }
  const tabs = isStaff() ? [["invoices", "Invoices"], ["accounts", "Supplier accounts"]] : [["submit", "Submit invoice"], ["mine", "My invoices"]];
  if (!S.tab || !tabs.some(t => t[0] === S.tab)) S.tab = tabs[0][0];
  renderTabs(tabs);
  const keep = document.activeElement?.id; const caret = document.activeElement?.selectionStart;
  if (S.tab === "submit") app.innerHTML = submitView();
  else if (S.tab === "mine") app.innerHTML = mineView();
  else if (S.tab === "invoices") app.innerHTML = queueView();
  else if (S.tab === "accounts") app.innerHTML = accountsView();
  bindView();
  if (keep) { const el = document.getElementById(keep); if (el && el !== document.activeElement && el.tagName === "INPUT" && el.type === "search") { el.focus(); try { el.setSelectionRange(caret, caret); } catch (e) {} } }
  renderDrawer();
}
function renderWho() {
  const w = $("#who");
  if (!S.session) { w.innerHTML = ""; return; }
  const p = S.profile;
  const label = p ? (isStaff() ? `${p.role === "admin" ? "Admin" : "Flexo staff"} · <b>${esc(p.contact_name || p.email)}</b>` : `<b>${esc(p.company_name || p.email)}</b>${p.vendor_code ? ` <span class="mono small muted">${esc(p.vendor_code)}</span>` : ""}`) : esc(S.session.user.email);
  w.innerHTML = `<span>${label}</span><button class="btn sm ghost" id="logout">Sign out</button>`;
  $("#logout").onclick = async () => { S.authMode = "signin"; S.recovering = false; S.lastSubmitted = null; await S.sb.auth.signOut(); };
}
function renderTabs(tabs) {
  const t = $("#tabs"); t.hidden = !tabs.length;
  t.innerHTML = tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${esc(l)}</button>`).join("");
  $$("[data-tab]", t).forEach(b => (b.onclick = () => { S.tab = b.dataset.tab; S.openId = null; render(); }));
}

// ---------- sign in / sign up / reset ----------
function authView() {
  const m = S.authMode;
  const f = (id, label, type = "text", extra = "") => `<div class="field"><label for="${id}">${label} <span class="req">*</span></label><input class="input" id="${id}" type="${type}" ${extra}></div>`;
  let body = "";
  if (m === "signin") body = `
    ${f("au-email", "Email", "email", 'autocomplete="email"')}
    ${f("au-pass", "Password", "password", 'autocomplete="current-password"')}
    <button class="btn primary" id="au-go">Sign in</button>
    <p class="small muted">New supplier? Choose <b>Sign up</b>. Flexo Accounting approves each account before invoices can be submitted.</p>`;
  else if (m === "signup") body = `
    ${f("su-company", "Company name (as registered with BIR)", "text", 'autocomplete="organization"')}
    <div class="grid g2">${f("su-tin", "TIN", "text", 'placeholder="000-000-000-00000"')}${f("su-phone", "Mobile / phone", "tel", 'autocomplete="tel"')}</div>
    ${f("su-contact", "Contact person", "text", 'autocomplete="name"')}
    ${f("su-email", "Email", "email", 'autocomplete="email"')}
    <div class="grid g2">${f("su-pass", "Password (min. 8)", "password", 'autocomplete="new-password"')}${f("su-pass2", "Confirm password", "password", 'autocomplete="new-password"')}</div>
    <button class="btn primary" id="au-go">Create account</button>
    <p class="small muted">After you sign up, Flexo Accounting checks your details and links your account to your supplier record. You can submit invoices once approved.</p>`;
  else body = `
    ${f("fp-email", "Email", "email", 'autocomplete="email"')}
    <button class="btn primary" id="au-go">Send reset link</button>
    <p class="small muted">We'll email you a link to set a new password. If it doesn't arrive, contact Flexo Accounting.</p>`;
  return `<div class="auth panel">
    <div class="panel-h"><h2>${m === "signup" ? "Supplier sign-up" : m === "forgot" ? "Reset password" : "Sign in"}</h2></div>
    <div class="panel-b">
      <div class="seg3" role="group" aria-label="Choose">
        <button data-mode="signin" aria-pressed="${m === "signin"}">Sign in</button>
        <button data-mode="signup" aria-pressed="${m === "signup"}">Sign up</button>
        <button data-mode="forgot" aria-pressed="${m === "forgot"}">Forgot password</button>
      </div>
      ${body}
      <p class="err" id="au-err" hidden></p>
      <div class="note ok" id="au-ok" hidden></div>
    </div></div>`;
}
function bindAuth() {
  $$("[data-mode]").forEach(b => (b.onclick = () => { S.authMode = b.dataset.mode; render(); }));
  const err = m => { const e = $("#au-err"); e.textContent = m; e.hidden = !m; };
  const ok = m => { const e = $("#au-ok"); e.textContent = m; e.hidden = !m; };
  const v = id => ($("#" + id)?.value || "").trim();
  const go = async () => {
    err(""); ok("");
    const btn = $("#au-go"); btn.disabled = true;
    try {
      if (S.authMode === "signin") {
        if (!v("au-email") || !$("#au-pass").value) return err("Enter your email and password.");
        const { error } = await S.sb.auth.signInWithPassword({ email: v("au-email"), password: $("#au-pass").value });
        if (error) return err(friendly(error));
      } else if (S.authMode === "signup") {
        const need = { "su-company": "company name", "su-tin": "TIN", "su-phone": "phone", "su-contact": "contact person", "su-email": "email" };
        const miss = Object.keys(need).filter(k => !v(k));
        if (miss.length) return err("Please fill in: " + miss.map(k => need[k]).join(", ") + ".");
        if (!/^\S+@\S+\.\S+$/.test(v("su-email"))) return err("Enter a valid email address.");
        if ($("#su-pass").value.length < 8) return err("Password must be at least 8 characters.");
        if ($("#su-pass").value !== $("#su-pass2").value) return err("The two passwords don't match.");
        const { data, error } = await S.sb.auth.signUp({
          email: v("su-email"), password: $("#su-pass").value,
          options: { emailRedirectTo: SITE_URL, data: { company_name: v("su-company"), tin: v("su-tin"), contact_name: v("su-contact"), phone: v("su-phone") } },
        });
        if (error) return err(friendly(error));
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return err(friendly({ message: "already registered" }));
        if (!data.session) ok("Account created. If you receive a confirmation email, click its link, then sign in. Flexo Accounting will review your account.");
      } else {
        if (!v("fp-email")) return err("Enter your email.");
        const { error } = await S.sb.auth.resetPasswordForEmail(v("fp-email"), { redirectTo: SITE_URL });
        if (error) return err(friendly(error));
        ok("If that email has an account, a reset link is on its way.");
      }
    } finally { if (btn.isConnected) btn.disabled = false; }
  };
  $("#au-go").onclick = go;
  $$("#app input").forEach(i => i.addEventListener("keydown", e => { if (e.key === "Enter") go(); }));
}
function resetView() {
  return `<div class="auth panel"><div class="panel-h"><h2>Set a new password</h2></div><div class="panel-b">
    <div class="field"><label for="rp-pass">New password (min. 8)</label><input class="input" id="rp-pass" type="password" autocomplete="new-password"></div>
    <div class="field"><label for="rp-pass2">Confirm new password</label><input class="input" id="rp-pass2" type="password" autocomplete="new-password"></div>
    <button class="btn primary" id="rp-go">Save password</button><p class="err" id="rp-err" hidden></p></div></div>`;
}
function bindReset() {
  $("#rp-go").onclick = async () => {
    const e = $("#rp-err"); const p = $("#rp-pass").value;
    if (p.length < 8) { e.textContent = "Password must be at least 8 characters."; e.hidden = false; return; }
    if (p !== $("#rp-pass2").value) { e.textContent = "The two passwords don't match."; e.hidden = false; return; }
    const { error } = await S.sb.auth.updateUser({ password: p });
    if (error) { e.textContent = friendly(error); e.hidden = false; return; }
    S.recovering = false; toast("Password updated."); render();
  };
}
function notApprovedView() {
  const p = S.profile;
  const msg = {
    pending: ["Account awaiting approval", "Thank you for signing up. Flexo Accounting is checking your details and will link your account to your supplier record. You can submit invoices once your account is approved."],
    rejected: ["Account not approved", "Flexo Accounting could not approve this account."],
    disabled: ["Account disabled", "This account has been disabled by Flexo Accounting."],
  }[p.status] || ["Account not active", ""];
  return `<div class="auth panel"><div class="panel-h"><h2>${msg[0]}</h2>${acctPill(p.status)}</div><div class="panel-b">
    <p class="muted" style="margin:0">${msg[1]}</p>
    ${p.status_note ? `<div class="note warn">Reason: ${esc(p.status_note)}</div>` : ""}
    <dl class="kv" style="margin:0">
      <div><dt>Company</dt><dd>${esc(p.company_name)}</dd></div><div><dt>TIN</dt><dd class="mono">${esc(p.tin)}</dd></div>
      <div><dt>Contact</dt><dd>${esc(p.contact_name)}</dd></div><div><dt>Phone</dt><dd>${esc(p.phone)}</dd></div>
      <div><dt>Email</dt><dd>${esc(p.email)}</dd></div><div><dt>Registered</dt><dd>${fmtDT(p.created_at)}</dd></div>
    </dl>
    <div class="row"><button class="btn" id="na-refresh">Check again</button></div>
    <p class="small muted" style="margin:0">Questions? Contact Flexo Accounting.</p></div></div>`;
}
function bindNotApproved() { $("#na-refresh").onclick = () => loadProfile(); }

// ---------- supplier: submit ----------
function submitView() {
  if (S.lastSubmitted) {
    const i = S.lastSubmitted;
    return `<section class="panel" style="margin-top:20px;max-width:760px"><div class="panel-b stack">
      <div class="verdict ready"><div class="seal">✓</div><div><div class="big">Invoice submitted</div>
        <div class="small">Invoice <b class="mono">${esc(i.invoice_no)}</b> · ${peso(i.total_amount)} · PO ${esc(i.po_no)} · DR ${esc(i.dr_no)}</div>
        <div class="small" style="margin-top:4px">Flexo Accounting will review it. Track its status under <b>My invoices</b>.</div></div></div>
      <div class="row"><button class="btn primary" id="new-inv">Submit another invoice</button><button class="btn" id="go-mine">View my invoices</button></div>
    </div></section>`;
  }
  const t = todayISO();
  const f = (id, label, type, extra = "", hint = "") => `<div class="field"><label for="${id}">${label} <span class="req">*</span></label><input class="input${type === "num" ? " num" : ""}" id="${id}" ${type === "num" ? 'type="text" inputmode="decimal" placeholder="0.00"' : `type="${type}"`} ${extra} required>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  return `<div class="flow" aria-label="How to submit">
      <div class="flow-step"><span class="k">STEP 1</span><b>Fill in the invoice details</b><span>Exactly as printed on your invoice and delivery receipt</span></div>
      <div class="flow-step"><span class="k">STEP 2</span><b>Attach the invoice</b><span>PDF or photo, max 10 MB</span></div>
      <div class="flow-step"><span class="k">STEP 3</span><b>Submit to Flexo</b><span>Track review and payment under My invoices</span></div>
    </div>
    <section class="panel" style="max-width:860px"><div class="panel-h"><h2>Submit an invoice</h2><span class="small muted">All fields are required</span></div>
    <form class="panel-b stack" id="inv-form" novalidate>
      <div class="grid g3">
        ${f("f-invno", "Invoice number", "text", 'class="mono" autocomplete="off"')}
        ${f("f-invdate", "Invoice date", "date", `max="${t}"`)}
        ${f("f-po", "PO number", "text", 'autocomplete="off"', "Flexo purchase order no.")}
      </div>
      <div class="grid g3">
        ${f("f-vatex", "VAT-exclusive amount (₱)", "num", "", "Amount before 12% VAT")}
        ${f("f-total", "Total amount (₱)", "num", "", "Total amount due incl. VAT")}
        <div class="field"><label>VAT (computed)</label><div class="input num muted" id="f-vat" aria-live="polite">—</div></div>
      </div>
      <div class="grid g3">
        ${f("f-dr", "DR number", "text", 'autocomplete="off"', "Delivery receipt no.")}
        ${f("f-drdate", "DR date", "date", `max="${t}"`)}
        <div></div>
      </div>
      <div class="field"><label for="f-file">Invoice file (PDF, JPG or PNG) <span class="req">*</span></label>
        <input class="input" id="f-file" type="file" accept="application/pdf,image/jpeg,image/png" required>
        <span class="hint">A clear scan or photo of the invoice. Max 10 MB.</span></div>
      <p class="err" id="f-err" hidden></p>
      <div class="row"><span style="flex:1"></span><button class="btn" type="reset" id="f-clear">Clear</button><button class="btn primary" type="submit" id="f-go">Submit to Flexo</button></div>
    </form></section>`;
}
function readInvoiceForm() {
  const v = id => ($("#" + id).value || "").trim();
  const out = { invoice_no: v("f-invno"), invoice_date: v("f-invdate"), po_no: v("f-po"), vatex_amount: num(v("f-vatex")), total_amount: num(v("f-total")), dr_no: v("f-dr"), dr_date: v("f-drdate") };
  const file = $("#f-file").files[0];
  const errs = [];
  const missing = [["invoice_no", "invoice number"], ["invoice_date", "invoice date"], ["po_no", "PO number"], ["vatex_amount", "VAT-exclusive amount"], ["total_amount", "total amount"], ["dr_no", "DR number"], ["dr_date", "DR date"]].filter(([k]) => out[k] === "" || out[k] == null).map(([, l]) => l);
  if (!file) missing.push("invoice file");
  if (missing.length) errs.push("Please fill in: " + missing.join(", ") + ".");
  const t = todayISO();
  if (out.invoice_date && out.invoice_date > t) errs.push("Invoice date can't be in the future.");
  if (out.dr_date && out.dr_date > t) errs.push("DR date can't be in the future.");
  if (out.vatex_amount != null && out.vatex_amount <= 0) errs.push("VAT-exclusive amount must be more than zero.");
  if (out.vatex_amount != null && out.total_amount != null && out.total_amount < out.vatex_amount) errs.push("Total amount can't be less than the VAT-exclusive amount.");
  if (file && !FILE_TYPES.includes(file.type)) errs.push("The file must be a PDF, JPG or PNG.");
  if (file && file.size > MAX_FILE) errs.push("The file is larger than 10 MB. Upload a smaller scan.");
  return { out, file, errs };
}
async function submitInvoice(e) {
  e.preventDefault();
  const errEl = $("#f-err");
  const { out, file, errs } = readInvoiceForm();
  if (errs.length) { errEl.textContent = errs.join(" "); errEl.hidden = false; return; }
  if (S.invoices.some(i => i.status !== "returned" && i.invoice_no.trim().toUpperCase() === out.invoice_no.toUpperCase())) {
    errEl.textContent = `You already submitted invoice ${out.invoice_no}. Check My invoices.`; errEl.hidden = false; return;
  }
  errEl.hidden = true;
  const btn = $("#f-go"); btn.disabled = true; btn.textContent = "Submitting…";
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "invoice";
  const path = `${S.session.user.id}/${Date.now()}-${safe}`;
  try {
    const up = await S.sb.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (up.error) throw up.error;
    const { data, error } = await S.sb.from("invoices").insert(Object.assign({}, out, { file_path: path, file_name: file.name })).select().single();
    if (error) { await S.sb.storage.from(BUCKET).remove([path]); throw error; }
    S.lastSubmitted = data; S.invoices.unshift(data); render();
  } catch (err) {
    errEl.textContent = friendly(err); errEl.hidden = false;
    if (btn.isConnected) { btn.disabled = false; btn.textContent = "Submit to Flexo"; }
  }
}

// ---------- supplier: my invoices ----------
function mineView() {
  const rows = S.invoices;
  return `<section class="panel" style="margin-top:20px"><div class="panel-h"><h2>My invoices</h2><span class="small muted">${rows.length} invoice${rows.length === 1 ? "" : "s"}</span><button class="btn sm" id="refresh">Refresh</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Submitted</th><th>Invoice no.</th><th>Invoice date</th><th>PO no.</th><th>DR no. / date</th><th class="num">VAT-ex</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map(i => `<tr>
    <td class="small mono">${fmtDT(i.created_at)}</td><td class="mono">${esc(i.invoice_no)}</td><td>${fmtDate(i.invoice_date)}</td><td class="mono">${esc(i.po_no)}</td>
    <td class="mono">${esc(i.dr_no)}<div class="small muted">${fmtDate(i.dr_date)}</div></td>
    <td class="num">${peso(i.vatex_amount)}</td><td class="num">${peso(i.total_amount)}</td>
    <td>${pill(i.status, true)}${i.status === "returned" ? `<div class="small" style="color:var(--bad)">${esc(i.return_reason)}</div><div class="small muted">Correct it and submit again.</div>` : ""}${i.status === "paid" ? `<div class="small muted">${fmtDate(i.paid_date)} · Ref ${esc(i.payment_ref)}</div>` : ""}</td>
    <td><button class="btn sm" data-file="${esc(i.id)}">View file</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">${S.loaded.invoices ? "No invoices submitted yet." : "Loading…"}</td></tr>`}
  </tbody></table></div></section>`;
}
async function openFile(inv) {
  const w = window.open("", "_blank");
  const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(inv.file_path, 600);
  if (error) { if (w) w.close(); toast(friendly(error)); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}

// ---------- staff: invoice queue ----------
function invMatches(i) {
  if (!S.q) return true;
  const q = S.q.toLowerCase();
  return [i.company_name, i.vendor_code, i.invoice_no, i.po_no, i.dr_no].join(" ").toLowerCase().includes(q);
}
function queueView() {
  const all = S.invoices;
  const agg = k => { const xs = k === "all" ? all : all.filter(i => i.status === k); return { c: xs.length, a: xs.reduce((s, i) => s + Number(i.total_amount || 0), 0) }; };
  const chips = [["submitted", "For review"], ["approved", "Approved for payment"], ["returned", "Returned"], ["paid", "Paid"], ["all", "All"]];
  const rows = all.filter(i => (S.filter === "all" || i.status === S.filter) && invMatches(i));
  return `<div class="chips">${chips.map(([k, l]) => { const a = agg(k); return `<button class="chip" data-chip="${k}" aria-pressed="${S.filter === k}"><span class="eyebrow">${l}</span><span class="n">${a.c}</span><span class="amt">${peso(a.a)}</span></button>`; }).join("")}</div>
  <section class="panel"><div class="panel-h"><h2>${esc(chips.find(c => c[0] === S.filter)[1])}</h2>
    <div class="filters"><input class="input" id="q" type="search" placeholder="Search supplier, invoice, PO, DR" value="${esc(S.q)}">
    <button class="btn sm" id="refresh">Refresh</button><button class="btn sm primary" id="export" ${rows.length ? "" : "disabled"}>Export CSV</button></div></div>
  <div class="tbl-wrap"><table><thead><tr><th>Submitted</th><th>Supplier</th><th>Invoice no. / date</th><th>PO no.</th><th>DR no. / date</th><th class="num">VAT-ex</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
  ${rows.map(i => `<tr class="click" data-open="${esc(i.id)}" tabindex="0">
    <td class="small mono">${fmtDT(i.created_at)}</td>
    <td><b>${esc(i.company_name)}</b><div class="small muted mono">${esc(i.vendor_code)}</div></td>
    <td class="mono">${esc(i.invoice_no)}<div class="small muted">${fmtDate(i.invoice_date)}</div></td>
    <td class="mono">${esc(i.po_no)}</td>
    <td class="mono">${esc(i.dr_no)}<div class="small muted">${fmtDate(i.dr_date)}</div></td>
    <td class="num">${peso(i.vatex_amount)}</td><td class="num">${peso(i.total_amount)}</td><td>${pill(i.status)}</td></tr>`).join("") || `<tr><td colspan="8" class="empty">${S.loaded.invoices ? "Nothing here." : "Loading…"}</td></tr>`}
  </tbody></table></div></section>`;
}
function exportCSV() {
  const rows = S.invoices.filter(i => (S.filter === "all" || i.status === S.filter) && invMatches(i));
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Status", "Vendor Code", "Supplier", "Invoice No", "Invoice Date", "PO No", "VAT-Exclusive Amount", "VAT", "Total Amount", "DR No", "DR Date", "Submitted", "Return Reason", "Paid Date", "Payment Ref"];
  const lines = [head.join(",")].concat(rows.map(i => [STATUS[i.status]?.label, i.vendor_code, i.company_name, i.invoice_no, i.invoice_date, i.po_no, i.vatex_amount, (Number(i.total_amount) - Number(i.vatex_amount)).toFixed(2), i.total_amount, i.dr_no, i.dr_date, i.created_at, i.return_reason, i.paid_date, i.payment_ref].map(q).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `flexo-invoices-${S.filter}-${todayISO()}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- staff: invoice detail ----------
async function renderDrawer() {
  const root = $("#drawerRoot");
  const inv = S.openId && isStaff() && S.invoices.find(i => i.id === S.openId);
  if (!inv) { root.innerHTML = ""; root.dataset.sig = ""; return; }
  const sig = inv.id + "|" + inv.updated_at;
  if (root.dataset.sig === sig) return;
  root.dataset.sig = sig;
  const vat = Number(inv.total_amount) - Number(inv.vatex_amount);
  const vatPct = Number(inv.vatex_amount) ? vat / Number(inv.vatex_amount) * 100 : 0;
  const dupInv = S.invoices.filter(o => o.id !== inv.id && o.vendor_code === inv.vendor_code && o.invoice_no.trim().toUpperCase() === inv.invoice_no.trim().toUpperCase());
  const dupDr = S.invoices.filter(o => o.id !== inv.id && o.vendor_code === inv.vendor_code && o.status !== "returned" && o.dr_no.trim().toUpperCase() === inv.dr_no.trim().toUpperCase());
  const notes = [];
  if (dupInv.length) notes.push(`Same invoice no. was also submitted ${dupInv.length}× before (${dupInv.map(o => STATUS[o.status].label).join(", ")}).`);
  if (dupDr.length) notes.push(`DR ${esc(inv.dr_no)} also appears on invoice ${dupDr.map(o => esc(o.invoice_no)).join(", ")}.`);
  if (Math.abs(vatPct - 12) > 0.5) notes.push(`VAT works out to ${vatPct.toFixed(2)}% of the VAT-exclusive amount (normally 12%).`);
  const acts = {
    submitted: `<button class="btn ok" id="a-approve">Approve for payment</button><button class="btn danger" id="a-return">Return to supplier…</button>`,
    approved: `<button class="btn primary" id="a-paid">Mark as paid…</button><button class="btn" id="a-back">Move back to review</button><button class="btn danger" id="a-return">Return to supplier…</button>`,
    returned: `<button class="btn" id="a-back">Reopen for review</button>`,
    paid: `<span class="small muted">Paid — no further actions.</span>`,
  }[inv.status];
  const isPdf = /\.pdf$/i.test(inv.file_name);
  root.innerHTML = `<div class="drawer-bg" id="dbg"></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-label="Invoice detail">
    <div class="drawer-h"><h2>${esc(inv.company_name)} · <span class="mono">${esc(inv.invoice_no)}</span></h2>${pill(inv.status)}<button class="btn sm" id="dclose">Close</button></div>
    <div class="drawer-b">
      <div class="stack">
        <div class="preview filebox" id="pv"><div class="ph"><div class="spinner"></div></div></div>
        <button class="btn sm" id="d-file">Open file in new tab</button>
        <div class="panel"><div class="panel-b"><div class="eyebrow" style="margin-bottom:8px">History</div><ul class="history" id="hist"><li class="muted">Loading…</li></ul></div></div>
      </div>
      <div class="stack">
        ${notes.length ? `<div class="note warn">${notes.map(n => `<div>⚠ ${n}</div>`).join("")}</div>` : ""}
        ${inv.status === "returned" ? `<div class="note bad">Return reason: ${esc(inv.return_reason)}</div>` : ""}
        ${inv.status === "paid" ? `<div class="note ok">Paid ${fmtDate(inv.paid_date)} · Ref <span class="mono">${esc(inv.payment_ref)}</span></div>` : ""}
        <div class="panel"><div class="panel-b"><dl class="kv" style="margin:0">
          <div><dt>Supplier</dt><dd>${esc(inv.company_name)} <span class="mono small muted">${esc(inv.vendor_code)}</span></dd></div>
          <div><dt>Invoice number</dt><dd class="mono">${esc(inv.invoice_no)}</dd></div>
          <div><dt>Invoice date</dt><dd>${fmtDate(inv.invoice_date)}</dd></div>
          <div><dt>PO number</dt><dd class="mono">${esc(inv.po_no)}</dd></div>
          <div><dt>DR number</dt><dd class="mono">${esc(inv.dr_no)}</dd></div>
          <div><dt>DR date</dt><dd>${fmtDate(inv.dr_date)}</dd></div>
          <div><dt>VAT-exclusive amount</dt><dd class="mono">${peso(inv.vatex_amount)}</dd></div>
          <div><dt>VAT (total − VAT-ex)</dt><dd class="mono">${peso(vat)} <span class="small muted">${vatPct.toFixed(2)}%</span></dd></div>
          <div><dt>Total amount</dt><dd class="mono"><b>${peso(inv.total_amount)}</b></dd></div>
          <div><dt>Submitted</dt><dd>${fmtDT(inv.created_at)}</dd></div>
          <div><dt>File</dt><dd class="small">${esc(inv.file_name)}</dd></div>
        </dl></div></div>
        <div class="note">Check the typed values against the attached invoice and SAP (PO, GRPO/DR) before approving.</div>
        <div class="panel"><div class="panel-b stack"><div class="row">${acts}</div><div id="d-action"></div></div></div>
      </div>
    </div>
  </aside>`;
  $("#dbg").onclick = $("#dclose").onclick = () => { S.openId = null; renderDrawer(); };
  $("#dclose").focus();
  $("#d-file").onclick = () => openFile(inv);
  bindDrawerActions(inv);
  // file preview + history
  S.sb.storage.from(BUCKET).createSignedUrl(inv.file_path, 600).then(({ data, error }) => {
    const pv = $("#pv"); if (!pv || S.openId !== inv.id) return;
    if (error || !data) { pv.innerHTML = `<div class="ph">Preview not available.</div>`; return; }
    pv.innerHTML = isPdf ? `<iframe src="${esc(data.signedUrl)}" title="Invoice file"></iframe>` : `<img src="${esc(data.signedUrl)}" alt="Invoice file">`;
  });
  S.sb.from("invoice_events").select("*").eq("invoice_id", inv.id).order("at", { ascending: false }).then(({ data, error }) => {
    const h = $("#hist"); if (!h || S.openId !== inv.id) return;
    const label = { submitted: "Submitted", approved: "Approved for payment", returned: "Returned to supplier", paid: "Marked paid" };
    h.innerHTML = error ? `<li class="muted">History not available.</li>` : (data || []).map(e => `<li><time>${fmtDT(e.at)}</time><span><b>${esc(e.actor_name)}</b> — ${esc(label[e.action] || e.action)}${e.note ? `: ${esc(e.note)}` : ""}</span></li>`).join("") || `<li class="muted">—</li>`;
  });
}
function bindDrawerActions(inv) {
  const act = $("#d-action");
  const update = async (patch, msg) => {
    const { data, error } = await S.sb.from("invoices").update(patch).eq("id", inv.id).select().single();
    if (error) { toast(friendly(error)); return; }
    const k = S.invoices.findIndex(i => i.id === inv.id); if (k >= 0) S.invoices[k] = data;
    toast(msg); render();
  };
  const confirmBox = (html, onOk) => {
    act.innerHTML = `<div class="inline-conf">${html}<button class="btn primary" id="c-ok">Confirm</button><button class="btn ghost" id="c-cancel">Cancel</button></div>`;
    $("#c-cancel").onclick = () => (act.innerHTML = "");
    $("#c-ok").onclick = onOk;
    const first = $("input", act); if (first) first.focus();
  };
  if ($("#a-approve")) $("#a-approve").onclick = () => update({ status: "approved" }, "Approved for payment");
  if ($("#a-back")) $("#a-back").onclick = () => update({ status: "submitted" }, "Moved back to review");
  if ($("#a-return")) $("#a-return").onclick = () => confirmBox(
    `<div class="field" style="flex:1;min-width:220px"><label for="c-reason">Reason (shown to the supplier)</label><input class="input" id="c-reason"></div>`,
    () => { const r = $("#c-reason").value.trim(); if (!r) return toast("Enter a reason."); update({ status: "returned", return_reason: r }, "Returned to supplier"); });
  if ($("#a-paid")) $("#a-paid").onclick = () => confirmBox(
    `<div class="field"><label for="c-date">Payment date</label><input class="input" type="date" id="c-date" value="${todayISO()}"></div>
     <div class="field" style="flex:1;min-width:180px"><label for="c-ref">Check / transfer ref. or SAP payment no.</label><input class="input mono" id="c-ref"></div>`,
    () => { const ref = $("#c-ref").value.trim(), d = $("#c-date").value; if (!d || !ref) return toast("Enter the payment date and reference."); update({ status: "paid", paid_date: d, payment_ref: ref }, "Marked as paid"); });
}

// ---------- staff: supplier accounts ----------
function accountsView() {
  const all = S.profiles;
  const groups = { pending: p => p.status === "pending", approved: p => p.status === "approved", inactive: p => ["rejected", "disabled"].includes(p.status), all: () => true };
  const labels = { pending: "Pending approval", approved: "Approved", inactive: "Rejected / disabled", all: "All" };
  const rows = all.filter(groups[S.acctFilter]);
  const canEdit = p => isAdmin() || (p.role === "supplier");
  return `<div class="chips">${Object.keys(groups).map(k => `<button class="chip" data-acct="${k}" aria-pressed="${S.acctFilter === k}"><span class="eyebrow">${labels[k]}</span><span class="n">${all.filter(groups[k]).length}</span></button>`).join("")}</div>
  <section class="panel"><div class="panel-h"><h2>${labels[S.acctFilter]}</h2><span class="small muted">Approve a supplier by entering their SAP vendor code (CardCode).</span><button class="btn sm" id="refresh">Refresh</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Registered</th><th>Company / TIN</th><th>Contact</th><th>Role</th><th>Status</th><th>SAP vendor code</th><th></th></tr></thead><tbody>
  ${rows.map(p => { const me = p.id === S.profile.id; const ed = canEdit(p) && !me; return `<tr data-pid="${esc(p.id)}">
    <td class="small mono">${fmtDT(p.created_at)}</td>
    <td><b>${esc(p.company_name)}</b><div class="small muted mono">${esc(p.tin)}</div></td>
    <td>${esc(p.contact_name)}<div class="small muted">${esc(p.email)}</div><div class="small muted">${esc(p.phone)}</div></td>
    <td>${isAdmin() && !me ? `<select class="input" data-role style="width:auto">${["supplier", "staff", "admin"].map(r => `<option value="${r}"${p.role === r ? " selected" : ""}>${r}</option>`).join("")}</select>` : esc(p.role)}</td>
    <td>${acctPill(p.status)}${p.status_note ? `<div class="small muted">${esc(p.status_note)}</div>` : ""}</td>
    <td>${p.role === "supplier" ? (ed ? `<input class="input mono" data-vc value="${esc(p.vendor_code || "")}" placeholder="e.g. V-00123" style="width:130px">` : `<span class="mono">${esc(p.vendor_code || "—")}</span>`) : `<span class="muted small">n/a</span>`}</td>
    <td>${ed ? `<div class="row">
      ${p.status !== "approved" ? `<button class="btn sm ok" data-do="approve">Approve</button>` : `<button class="btn sm" data-do="save">Save</button>`}
      ${p.status === "pending" ? `<button class="btn sm danger" data-do="reject">Reject</button>` : ""}
      ${p.status === "approved" ? `<button class="btn sm danger" data-do="disable">Disable</button>` : ""}
    </div>` : `<span class="small muted">${me ? "You" : ""}</span>`}</td></tr>`; }).join("") || `<tr><td colspan="7" class="empty">${S.loaded.profiles ? "No accounts here." : "Loading…"}</td></tr>`}
  </tbody></table></div>
  <div class="panel-b"><div class="note">New staff: ask them to sign up on this page, then an admin sets their role to <b>staff</b> and approves them.</div></div></section>`;
}
async function accountAction(tr, what) {
  const p = S.profiles.find(x => x.id === tr.dataset.pid); if (!p) return;
  const vc = $("[data-vc]", tr)?.value.trim();
  const role = $("[data-role]", tr)?.value || p.role;
  const patch = {};
  if (isAdmin() && role !== p.role) patch.role = role;
  if (role === "supplier" && vc !== undefined && vc !== (p.vendor_code || "")) patch.vendor_code = vc || null;
  if (what === "approve") {
    if (role === "supplier" && !vc) return toast("Enter the SAP vendor code before approving this supplier.");
    patch.status = "approved"; patch.status_note = null;
  } else if (what === "reject" || what === "disable") {
    const r = prompt(what === "reject" ? "Reason for rejecting (shown to the applicant):" : "Reason for disabling (shown to the supplier):");
    if (r === null) return;
    patch.status = what === "reject" ? "rejected" : "disabled"; patch.status_note = r.trim() || null;
  } else if (what === "save") {
    if (role === "supplier" && p.status === "approved" && !vc) return toast("An approved supplier needs a vendor code.");
    if (!Object.keys(patch).length) return toast("Nothing to save.");
  }
  const { data, error } = await S.sb.from("profiles").update(patch).eq("id", p.id).select().single();
  if (error) return toast(friendly(error));
  const k = S.profiles.findIndex(x => x.id === p.id); if (k >= 0) S.profiles[k] = data;
  toast({ approve: "Account approved", reject: "Account rejected", disable: "Account disabled", save: "Saved" }[what]); render();
}

// ---------- event binding ----------
function bindView() {
  const app = $("#app");
  if ($("#inv-form")) {
    $("#inv-form").onsubmit = submitInvoice;
    $("#inv-form").addEventListener("input", () => { $("#f-err").hidden = true; });
    $("#inv-form").addEventListener("change", () => { $("#f-err").hidden = true; });
    const calc = () => { const a = num($("#f-vatex").value), b = num($("#f-total").value); $("#f-vat").textContent = a != null && b != null ? `${peso(b - a)}  (${a ? ((b - a) / a * 100).toFixed(2) : "0.00"}%)` : "—"; };
    $("#f-vatex").oninput = $("#f-total").oninput = calc;
    $("#f-clear").onclick = () => setTimeout(calc, 0);
  }
  if ($("#new-inv")) $("#new-inv").onclick = () => { S.lastSubmitted = null; render(); };
  if ($("#go-mine")) $("#go-mine").onclick = () => { S.lastSubmitted = null; S.tab = "mine"; render(); };
  $$("[data-file]", app).forEach(b => (b.onclick = () => { const i = S.invoices.find(x => x.id === b.dataset.file); if (i) openFile(i); }));
  if ($("#refresh")) $("#refresh").onclick = () => { if (S.tab === "accounts") loadProfiles(); else loadInvoices(); };
  $$("[data-chip]", app).forEach(b => (b.onclick = () => { S.filter = b.dataset.chip; render(); }));
  if ($("#q")) $("#q").oninput = e => { S.q = e.target.value; clearTimeout(bindView.t); bindView.t = setTimeout(render, 200); };
  if ($("#export")) $("#export").onclick = exportCSV;
  $$("[data-open]", app).forEach(r => { const open = () => { S.openId = r.dataset.open; renderDrawer(); }; r.onclick = open; r.onkeydown = e => { if (e.key === "Enter") open(); }; });
  $$("[data-acct]", app).forEach(b => (b.onclick = () => { S.acctFilter = b.dataset.acct; render(); }));
  $$("[data-do]", app).forEach(b => (b.onclick = () => accountAction(b.closest("tr"), b.dataset.do)));
}

document.addEventListener("keydown", e => { if (e.key === "Escape" && S.openId) { S.openId = null; renderDrawer(); } });
boot();
})();
