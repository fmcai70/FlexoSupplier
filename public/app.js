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
// Phone photos are often 5–20 MB, HEIC, or arrive without a file type. Turn any photo the
// browser can open into a ~2000px JPEG (usually under 1 MB); PDFs pass through unchanged.
async function prepareUpload(file) {
  const name = file.name || "photo.jpg";
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (file.type === "application/pdf" || ext === "pdf") {
    if (file.size > MAX_FILE) throw new Error("The PDF is larger than 10 MB. Please upload a smaller scan.");
    return new File([file], name, { type: "application/pdf" });
  }
  const isImage = (file.type || "").startsWith("image/") || ["jpg", "jpeg", "png", "heic", "heif", "webp"].includes(ext) || !file.type;
  if (!isImage) throw new Error("Please choose a PDF or a photo (JPG or PNG).");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight, scale = Math.min(1, 2000 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
    let q = 0.85, blob = null;
    for (let k = 0; k < 5; k++) { blob = await new Promise(r => c.toBlob(r, "image/jpeg", q)); if (blob && blob.size <= MAX_FILE) break; q -= 0.15; }
    if (!blob || blob.size > MAX_FILE) throw new Error("too big");
    return new File([blob], name.replace(/\.[^.]*$/, "") + ".jpg", { type: "image/jpeg" });
  } catch (e) {
    throw new Error("This photo couldn't be read. Take the photo again, or on iPhone set Settings → Camera → Formats → Most Compatible. You can also upload a PDF.");
  } finally { URL.revokeObjectURL(url); }
}
const fileSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
// Two sign-in pages share this code: suppliers at the site root, Flexo staff at /staff/.
const MODE = window.PORTAL_MODE === "staff" ? "staff" : "supplier";
const STAFF_DOMAIN = "@flexo.com.ph";
const SUPPLIER_URL = new URL(MODE === "staff" ? "../" : "./", location.href).href;
const STAFF_URL = new URL(MODE === "staff" ? "./" : "staff/", location.href).href;
const SITE_URL = MODE === "staff" ? STAFF_URL : SUPPLIER_URL; // where email links return to

const S = {
  sb: null, session: null, profile: null, recovering: false,
  tab: null, authMode: "signin",
  invoices: [], profiles: [], loaded: { invoices: false, profiles: false },
  filter: "submitted", q: "", acctFilter: "pending",
  openId: null, lastSubmitted: null, sel: new Set(),
  draft: { fields: {}, file: null, preview: null, busy: false, lostFile: "" }, // invoice form survives re-renders
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { const x = parseFloat(String(v ?? "").replace(/[,\s₱]|PHP/gi, "")); return isFinite(x) ? x : null; };
const peso = v => v == null ? "—" : "₱ " + Number(v).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = s => { if (!s) return "—"; const d = new Date(String(s).length === 10 ? s + "T00:00:00" : s); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-PH", { year: "numeric", month: "short", day: "numeric" }); };
const fmtDT = s => { if (!s) return "—"; const d = new Date(s); return isNaN(d) ? esc(s) : d.toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// Staff/admin by role. Staff powers also need a strong login (S.mfaOk): password + authenticator
// code, or "Sign in with Microsoft 365". The database enforces the same rule (strong_login()).
const isStaffRole = () => S.profile && ["staff", "admin"].includes(S.profile.role) && S.profile.status === "approved";
const isStaff = () => isStaffRole() && S.mfaOk;
const isAdmin = () => isStaff() && S.profile.role === "admin";
const isSupplier = () => S.profile && S.profile.role === "supplier" && S.profile.status === "approved";

function toast(msg) {
  const r = $("#toastRoot");
  r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toast.t); toast.t = setTimeout(() => (r.innerHTML = ""), 3600);
}
// Ask the "notify" Edge Function to send queued emails now. It only sends what the
// database already queued, so extra calls are harmless; if it isn't deployed, nothing happens.
function sendEmails() {
  clearTimeout(sendEmails.t);
  sendEmails.t = setTimeout(() => {
    if (!S.base) return;
    fetch(S.base + "/functions/v1/notify", { method: "POST", headers: { apikey: S.key, Authorization: "Bearer " + (S.session?.access_token || S.key), "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }, 600);
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
  if (/hook|error sending .*email|smtp/i.test(m)) return "We couldn't send the email right now. Please try again in a few minutes, or contact Flexo Accounting.";
  return m || "Something went wrong. Please try again.";
}

const STATUS = {
  submitted: { label: "For review", sup: "Received — under review", cls: "p-submitted" },
  approved: { label: "Checked OK — to schedule", sup: "Checked OK — awaiting payment schedule", cls: "p-approved" },
  scheduled: { label: "Scheduled for release", sup: "Payment scheduled", cls: "p-ready" },
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
  S.base = baseUrl; S.key = anonKey;
  S.sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") S.recovering = true;
    const changed = (session?.user?.id || null) !== (S.session?.user?.id || null);
    S.session = session;
    if (changed) { S.mfaOk = false; S.factors = []; S.enroll = null; S.profile = null; S.tab = null; S.invoices = []; S.profiles = []; S.loaded = { invoices: false, profiles: false }; S.openId = null; setTimeout(loadProfile, 0); }
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
  if (isStaffRole()) await checkMfa();
  if (isSupplier()) restoreDraft();
  render();
  if (isSupplier() || isStaff()) loadInvoices();
  if (isStaff()) { loadProfiles(); sendEmails(); }
}
async function checkMfa() {
  S.mfaOk = false; S.factors = []; S.enroll = null;
  const { data } = await S.sb.auth.mfa.getAuthenticatorAssuranceLevel();
  const methods = (data?.currentAuthenticationMethods || []).map(m => m.method);
  S.mfaOk = data?.currentLevel === "aal2" || methods.includes("oauth");
  if (!S.mfaOk) {
    const f = await S.sb.auth.mfa.listFactors();
    S.factors = (f.data?.totp || []).filter(x => x.status === "verified");
  }
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
  document.body.classList.toggle("auth-mode", !S.session || (S.recovering && !!S.session));
  if (S.recovering && S.session) { renderTabs([]); app.innerHTML = resetView(); bindReset(); return; }
  if (!S.session) { renderTabs([]); app.innerHTML = authView(); bindAuth(); renderDrawer(); return; }
  if (!S.profile) { renderTabs([]); app.innerHTML = `<div class="empty" style="padding-top:80px"><div class="spinner" style="margin:0 auto 10px"></div>Loading your account…</div>`; return; }
  const p = S.profile;
  const staffRequest = p.role === "supplier" && p.requested_role === "staff" && p.status !== "approved";
  if (MODE === "supplier" && (isStaffRole() || staffRequest)) { location.replace(STAFF_URL); return; }
  if (MODE === "staff" && !isStaffRole() && !staffRequest) { renderTabs([]); app.innerHTML = wrongPageView(); bindWrongPage(); return; }
  if (isStaffRole() && !S.mfaOk) { renderTabs([]); app.innerHTML = mfaView(); bindMfa(); return; }
  if (!isSupplier() && !isStaff()) { renderTabs([]); app.innerHTML = notApprovedView(); bindNotApproved(); return; }
  const tabs = isStaff() ? [["invoices", "Invoices"], ["accounts", "Accounts"]] : [["submit", "Submit invoice"], ["mine", "My invoices"]];
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
  const label = p ? (isStaffRole() ? `${p.role === "admin" ? "Admin" : "Flexo staff"} · <b>${esc(p.contact_name || p.email)}</b>` : `<b>${esc(p.company_name || p.email)}</b>${p.vendor_code ? ` <span class="mono small muted">${esc(p.vendor_code)}</span>` : ""}`) : esc(S.session.user.email);
  w.innerHTML = `<span>${label}</span><button class="btn sm ghost" id="logout">Sign out</button>`;
  $("#logout").onclick = async () => { S.authMode = "signin"; S.recovering = false; S.lastSubmitted = null; await S.sb.auth.signOut(); };
}
function renderTabs(tabs) {
  const t = $("#tabs"); t.hidden = !tabs.length;
  t.innerHTML = tabs.map(([k, l]) => `<button class="tab" role="tab" aria-selected="${S.tab === k}" data-tab="${k}">${esc(l)}</button>`).join("");
  $$("[data-tab]", t).forEach(b => (b.onclick = () => { S.tab = b.dataset.tab; S.openId = null; render(); }));
}

// ---------- sign in / sign up / reset ----------
function authShell(card) {
  const staff = MODE === "staff";
  const points = staff
    ? ["Review supplier invoices with the attached file", "Schedule Friday check releases in one go", "Record payments with proof of payment"]
    : ["Submit your invoice with a scan or photo", "See when it's checked, scheduled and paid", "Know your check-release date and amount"];
  return `<div class="auth-split">
    <aside class="auth-side">
      <div class="auth-brand"><div class="brand-mark" aria-hidden="true">F</div><div><b>Flexo Manufacturing Corporation</b><span>${staff ? "Accounts Payable · staff" : "Supplier Invoice Portal"}</span></div></div>
      <h1>${staff ? "Review, schedule and pay supplier invoices." : "Submit invoices and track your payments in one place."}</h1>
      <ul>${points.map(t => `<li>${t}</li>`).join("")}</ul>
      <p class="auth-foot">${staff ? "For Flexo staff only." : "Questions about an invoice? Contact Flexo Accounting."}</p>
    </aside>
    <section class="auth-main"><div class="auth-card">${card}</div></section>
  </div>`;
}
const aField = (id, label, type, extra = "", hint = "") => `<div class="field"><label for="${id}">${label}</label><input class="input" id="${id}" type="${type}" ${extra} required>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
const aPass = (id, label, ac, side = "") => `<div class="field"><div class="label-row"><label for="${id}">${label}</label>${side}</div>
  <div class="pw-wrap"><input class="input" id="${id}" type="password" autocomplete="${ac}" required><button type="button" class="pw-toggle" data-pw="${id}" aria-label="Show password">Show</button></div></div>`;
const aLink = (mode, text) => `<button type="button" class="linkbtn" data-mode="${mode}">${text}</button>`;
const aMsgs = `<p class="err" id="au-err" role="alert" hidden></p><div class="note ok" id="au-ok" role="status" hidden></div>`;

function authView() {
  const m = S.authMode;
  if (MODE === "staff") return staffAuthView();
  if (m === "signup") return authShell(`
    <h2>Create a supplier account</h2>
    <p class="lead">Flexo Accounting reviews each new account. Once approved, you can submit invoices here.</p>
    <form id="auth-form" class="stack" novalidate>
      <fieldset class="auth-group"><legend>Company</legend>
        ${aField("su-company", "Company name (as registered with BIR)", "text", 'autocomplete="organization"')}
        <div class="grid g2">${aField("su-tin", "TIN", "text", 'placeholder="000-000-000-000"')}${aField("su-phone", "Mobile / phone", "tel", 'autocomplete="tel"')}</div>
        ${aField("su-contact", "Contact person", "text", 'autocomplete="name"')}
      </fieldset>
      <fieldset class="auth-group"><legend>Sign-in details</legend>
        ${aField("su-email", "Email", "email", 'autocomplete="email"')}
        ${aPass("su-pass", "Password", "new-password", '<span class="hint">At least 8 characters</span>')}
        ${aPass("su-pass2", "Confirm password", "new-password")}
      </fieldset>
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Create account</button>
    </form>
    <div class="auth-alt">Already have an account? ${aLink("signin", "Sign in")}</div>`);
  if (m === "forgot") return authShell(`
    <h2>Reset your password</h2>
    <p class="lead">Enter the email you signed up with and we'll send you a link to set a new password.</p>
    <form id="auth-form" class="stack" novalidate>
      ${aField("fp-email", "Email", "email", 'autocomplete="email"')}
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Send reset link</button>
    </form>
    <div class="auth-alt">${aLink("signin", "← Back to sign in")}</div>`);
  return authShell(`
    <h2>Sign in</h2>
    <p class="lead">Welcome back. Sign in to submit invoices and check your payments.</p>
    <form id="auth-form" class="stack" novalidate>
      ${aField("au-email", "Email", "email", 'autocomplete="email"')}
      ${aPass("au-pass", "Password", "current-password", aLink("forgot", "Forgot password?"))}
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Sign in</button>
    </form>
    <div class="auth-alt">New supplier? ${aLink("signup", "Create an account")}</div>`);
}
function staffAuthView() {
  const m = S.authMode === "signup" ? "request" : S.authMode;
  const supplierLink = `<p class="auth-switch">Supplier? <a href="${esc(SUPPLIER_URL)}">Go to the supplier portal</a></p>`;
  if (m === "request") return authShell(`
    <h2>Request staff access</h2>
    <p class="lead">Use your ${STAFF_DOMAIN} email. An admin approves each request.</p>
    <form id="auth-form" class="stack" novalidate>
      ${aField("rq-name", "Full name", "text", 'autocomplete="name"')}
      ${aField("rq-email", "Flexo email", "email", `autocomplete="email" placeholder="name${STAFF_DOMAIN}"`)}
      ${aPass("rq-pass", "Password", "new-password", '<span class="hint">At least 8 characters</span>')}
      ${aPass("rq-pass2", "Confirm password", "new-password")}
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Request access</button>
    </form>
    <div class="auth-alt">Already have access? ${aLink("signin", "Sign in")}</div>${supplierLink}`);
  if (m === "forgot") return authShell(`
    <h2>Reset your password</h2>
    <p class="lead">Enter your Flexo email and we'll send you a link to set a new password.</p>
    <form id="auth-form" class="stack" novalidate>
      ${aField("fp-email", "Flexo email", "email", 'autocomplete="email"')}
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Send reset link</button>
    </form>
    <div class="auth-alt">${aLink("signin", "← Back to sign in")}</div>${supplierLink}`);
  return authShell(`
    <h2>Staff sign in</h2>
    <p class="lead">Flexo Accounts Payable</p>
    ${cfg.microsoftLogin ? `<button class="btn block ms-btn" id="ms-go" type="button">${MS_ICON} Sign in with Microsoft 365</button>
    <div class="or"><span>or</span></div>` : ""}
    <form id="auth-form" class="stack" novalidate>
      ${aField("au-email", "Flexo email", "email", 'autocomplete="email"')}
      ${aPass("au-pass", "Password", "current-password", aLink("forgot", "Forgot password?"))}
      ${aMsgs}
      <button class="btn primary block" id="au-go" type="submit">Sign in</button>
      <p class="small muted" style="margin:0;text-align:center">Next, you'll enter the 6-digit code from your authenticator app.</p>
    </form>
    <div class="auth-alt">Need access? ${aLink("request", "Request staff access")}</div>${supplierLink}`);
}
const MS_ICON = `<svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>`;

// ---------- staff two-step login (authenticator app) ----------
function mfaView() {
  const p = S.profile;
  if (S.factors.length) return `<div class="auth panel"><div class="panel-h"><h2>Two-step login</h2><span class="pill p-approved">Staff</span></div><div class="panel-b">
    <p class="muted" style="margin:0">Hello ${esc(p.contact_name || p.email)}. Open your authenticator app and enter the 6-digit code for <b>Flexo Invoice Portal</b>.</p>
    <div class="field"><label for="mfa-code">6-digit code</label><input class="input mono" id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="font-size:20px;letter-spacing:.2em;text-align:center"></div>
    <button class="btn primary" id="mfa-go">Verify</button><p class="err" id="mfa-err" hidden></p>
    <p class="small muted" style="margin:0">Lost your phone? Ask an admin to reset your two-step login.</p></div></div>`;
  const e = S.enroll;
  return `<div class="auth panel" style="max-width:560px"><div class="panel-h"><h2>Set up two-step login</h2><span class="pill p-approved">Staff</span></div><div class="panel-b">
    <p class="muted" style="margin:0">Staff accounts need a second step when signing in with a password. This takes one minute, once.</p>
    <ol class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
      <li>Install <b>Microsoft Authenticator</b> or <b>Google Authenticator</b> on your phone.</li>
      <li>In the app, add an account and <b>scan this QR code</b>.</li>
      <li>Enter the 6-digit code the app shows.</li></ol>
    <div style="display:grid;place-items:center;padding:8px;background:#fff;border:1px solid var(--line);border-radius:10px;min-height:200px">${e ? `<img src="${esc(e.qr)}" alt="QR code for your authenticator app" width="200" height="200">` : `<div class="spinner"></div>`}</div>
    ${e ? `<p class="small muted" style="margin:0">Can't scan? Enter this key in the app: <span class="mono" style="overflow-wrap:anywhere">${esc(e.secret)}</span></p>` : ""}
    <div class="field"><label for="mfa-code">6-digit code</label><input class="input mono" id="mfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="font-size:20px;letter-spacing:.2em;text-align:center"></div>
    <button class="btn primary" id="mfa-go" ${e ? "" : "disabled"}>Turn on two-step login</button><p class="err" id="mfa-err" hidden></p></div></div>`;
}
async function startEnroll() {
  if (S.enroll || S.enrolling) return;
  S.enrolling = true;
  try {
    // clear any half-finished setup from an earlier attempt
    const f = await S.sb.auth.mfa.listFactors();
    for (const x of (f.data?.all || []).filter(x => x.factor_type === "totp" && x.status !== "verified")) await S.sb.auth.mfa.unenroll({ factorId: x.id });
    const { data, error } = await S.sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Flexo Invoice Portal " + Date.now().toString(36), issuer: "Flexo Invoice Portal" });
    if (error) { toast(friendly(error)); return; }
    S.enroll = { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
  } finally { S.enrolling = false; render(); }
}
function bindMfa() {
  if (!S.factors.length && !S.enroll) startEnroll();
  const go = async () => {
    const code = ($("#mfa-code").value || "").replace(/\D/g, ""); const e = $("#mfa-err");
    if (code.length !== 6) { e.textContent = "Enter the 6-digit code from your app."; e.hidden = false; return; }
    const factorId = S.factors.length ? S.factors[0].id : S.enroll?.id;
    if (!factorId) return;
    $("#mfa-go").disabled = true;
    const { error } = await S.sb.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) { e.textContent = /invalid|expired/i.test(error.message || "") ? "That code didn't work. Wait for a new code in the app and try again." : friendly(error); e.hidden = false; $("#mfa-go").disabled = false; return; }
    toast(S.factors.length ? "Verified" : "Two-step login is on");
    await loadProfile();
  };
  $("#mfa-go").onclick = go;
  $("#mfa-code").addEventListener("keydown", ev => { if (ev.key === "Enter") go(); });
  $("#mfa-code").focus();
}
function wrongPageView() {
  return `<div class="auth panel"><div class="panel-h"><h2>This page is for Flexo staff</h2></div><div class="panel-b">
    <p class="muted" style="margin:0">You're signed in with a supplier account. Suppliers use the supplier portal.</p>
    <div class="row"><a class="btn primary" href="${esc(SUPPLIER_URL)}">Go to the supplier portal</a><button class="btn" id="wp-out">Sign out</button></div></div></div>`;
}
function bindWrongPage() { $("#wp-out").onclick = () => $("#logout").click(); }
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
      } else if (S.authMode === "request") {
        if (!v("rq-name") || !v("rq-email")) return err("Enter your full name and Flexo email.");
        if (!v("rq-email").toLowerCase().endsWith(STAFF_DOMAIN)) return err(`Use your Flexo email (ending in ${STAFF_DOMAIN}).`);
        if ($("#rq-pass").value.length < 8) return err("Password must be at least 8 characters.");
        if ($("#rq-pass").value !== $("#rq-pass2").value) return err("The two passwords don't match.");
        const { data, error } = await S.sb.auth.signUp({
          email: v("rq-email"), password: $("#rq-pass").value,
          options: { emailRedirectTo: SITE_URL, data: { company_name: "Flexo Manufacturing Corporation", contact_name: v("rq-name"), requested_role: "staff" } },
        });
        if (error) return err(friendly(error));
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return err(friendly({ message: "already registered" }));
        sendEmails();
        if (!data.session) ok("Request sent. Sign in once an admin has approved it.");
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
        sendEmails();
        if (!data.session) ok("Account created. If you receive a confirmation email, click its link, then sign in. Flexo Accounting will review your account.");
      } else {
        if (!v("fp-email")) return err("Enter your email.");
        const { error } = await S.sb.auth.resetPasswordForEmail(v("fp-email"), { redirectTo: SITE_URL });
        if (error) return err(friendly(error));
        ok("If that email has an account, a reset link is on its way.");
      }
    } finally { if (btn.isConnected) btn.disabled = false; }
  };
  $("#auth-form").onsubmit = e => { e.preventDefault(); go(); };
  if ($("#ms-go")) $("#ms-go").onclick = async () => {
    const { error } = await S.sb.auth.signInWithOAuth({ provider: "azure", options: { scopes: "openid email profile", redirectTo: STAFF_URL } });
    if (error) err(friendly(error));
  };
  bindPwToggles();
  const first = $("#auth-form input"); if (first && !matchMedia("(max-width: 860px)").matches) first.focus();
}
function bindPwToggles() {
  $$(".pw-toggle").forEach(b => (b.onclick = () => {
    const i = document.getElementById(b.dataset.pw); const show = i.type === "password";
    i.type = show ? "text" : "password"; b.textContent = show ? "Hide" : "Show"; b.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }));
}
function resetView() {
  const needCode = !!S.resetFactor;
  return authShell(`
    <h2>Set a new password</h2>
    <p class="lead">Choose a new password for ${esc(S.session?.user?.email || "your account")}.</p>
    ${S.resetFactor === undefined ? `<div class="empty"><div class="spinner" style="margin:0 auto"></div></div>` : `
    <form id="rp-form" class="stack" novalidate>
      ${aPass("rp-pass", "New password", "new-password", '<span class="hint">At least 8 characters</span>')}
      ${aPass("rp-pass2", "Confirm new password", "new-password")}
      ${needCode ? `<div class="field"><label for="rp-code">6-digit code from your authenticator app</label>
        <input class="input mono" id="rp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="letter-spacing:.2em;text-align:center;font-size:18px" required>
        <span class="hint">Your account uses two-step login, so the code is needed to change the password.</span></div>` : ""}
      <p class="err" id="rp-err" role="alert" hidden></p>
      <button class="btn primary block" id="rp-go" type="submit">Save password</button>
    </form>`}`);
}
// Accounts with two-step login must confirm a 6-digit code before Supabase lets the password change.
async function loadResetFactor() {
  const [{ data: aal }, { data: f }] = await Promise.all([S.sb.auth.mfa.getAuthenticatorAssuranceLevel(), S.sb.auth.mfa.listFactors()]);
  const verified = (f?.totp || []).filter(x => x.status === "verified");
  S.resetFactor = aal?.currentLevel !== "aal2" && verified.length ? verified[0].id : null;
  render();
}
function bindReset() {
  if (S.resetFactor === undefined) { if (!S.resetLoading) { S.resetLoading = true; loadResetFactor().finally(() => (S.resetLoading = false)); } return; }
  bindPwToggles();
  $("#rp-form").onsubmit = async ev => {
    ev.preventDefault();
    const e = $("#rp-err"); const p = $("#rp-pass").value;
    const fail = m => { e.textContent = m; e.hidden = false; $("#rp-go").disabled = false; };
    if (p.length < 8) return fail("Password must be at least 8 characters.");
    if (p !== $("#rp-pass2").value) return fail("The two passwords don't match.");
    $("#rp-go").disabled = true;
    if (S.resetFactor) {
      const code = ($("#rp-code").value || "").replace(/\D/g, "");
      if (code.length !== 6) return fail("Enter the 6-digit code from your authenticator app.");
      const v = await S.sb.auth.mfa.challengeAndVerify({ factorId: S.resetFactor, code });
      if (v.error) return fail(/invalid|expired/i.test(v.error.message || "") ? "That code didn't work. Wait for a new code in the app and try again." : friendly(v.error));
      S.resetFactor = null;
    }
    const { error } = await S.sb.auth.updateUser({ password: p });
    if (error) return fail(/aal2/i.test(error.message || "") ? "Please enter the 6-digit code from your authenticator app." : friendly(error));
    S.recovering = false; S.resetFactor = undefined; toast("Password updated."); await loadProfile();
  };
}
function notApprovedView() {
  const p = S.profile;
  if (MODE === "staff") {
    const t = { pending: ["Staff access requested", "An admin will review your request. Once approved, sign in again (or click Check again) to open the staff portal."], rejected: ["Staff access not approved", "An admin did not approve this request."], disabled: ["Access disabled", "This account has been disabled by an admin."] }[p.status] || ["Access not active", ""];
    return `<div class="auth panel"><div class="panel-h"><h2>${t[0]}</h2>${acctPill(p.status)}</div><div class="panel-b">
      <p class="muted" style="margin:0">${t[1]}</p>${p.status_note ? `<div class="note warn">Reason: ${esc(p.status_note)}</div>` : ""}
      <dl class="kv" style="margin:0"><div><dt>Name</dt><dd>${esc(p.contact_name)}</dd></div><div><dt>Email</dt><dd>${esc(p.email)}</dd></div><div><dt>Requested</dt><dd>${fmtDT(p.created_at)}</dd></div></dl>
      <div class="row"><button class="btn" id="na-refresh">Check again</button></div></div></div>`;
  }
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
// Keep typed values if the phone reloads the page while the camera is open (the photo itself can't be kept).
const draftKey = () => "fx_invoice_draft_" + (S.session?.user?.id || "");
function saveDraft() { try { sessionStorage.setItem(draftKey(), JSON.stringify({ fields: S.draft.fields, fileName: S.draft.file?.name || "" })); } catch (e) {} }
function restoreDraft() {
  try { const d = JSON.parse(sessionStorage.getItem(draftKey()) || "null"); if (d && !Object.keys(S.draft.fields).length) { S.draft.fields = d.fields || {}; if (d.fileName && !S.draft.file) S.draft.lostFile = d.fileName; } } catch (e) {}
}
function clearDraft() {
  if (S.draft.preview) URL.revokeObjectURL(S.draft.preview);
  S.draft = { fields: {}, file: null, preview: null, busy: false, lostFile: "" };
  try { sessionStorage.removeItem(draftKey()); } catch (e) {}
}
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
  const d = S.draft;
  const f = (id, label, type, extra = "", hint = "") => `<div class="field"><label for="${id}">${label} <span class="req">*</span></label><input class="input${type === "num" ? " num" : ""}" id="${id}" data-draft ${type === "num" ? 'type="text" inputmode="decimal" placeholder="0.00"' : `type="${type}"`} value="${esc(d.fields[id] || "")}" ${extra} required>${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const attach = d.busy ? `<div class="attach-item"><div class="spinner"></div><span>Preparing photo…</span></div>`
    : d.file ? `<div class="attach-item">${d.preview ? `<img src="${d.preview}" alt="Attached invoice photo">` : `<span class="attach-pdf">PDF</span>`}
        <div style="min-width:0;flex:1"><b style="overflow-wrap:anywhere">${esc(d.file.name)}</b><div class="small muted">${fileSize(d.file.size)} · ready to submit</div></div>
        <button type="button" class="btn sm" id="f-remove">Remove</button></div>`
    : `<div class="row">
        <label class="btn primary" for="f-cam">📷 Take a photo</label>
        <label class="btn" for="f-file">Choose file</label></div>
        ${d.lostFile ? `<div class="note warn" style="margin-top:8px">Please attach the invoice again — the page was reloaded while the camera was open.</div>` : ""}`;
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
      <div class="field"><label>Invoice file (photo or PDF) <span class="req">*</span></label>
        <div class="attach">${attach}</div>
        <input id="f-cam" type="file" accept="image/*" capture="environment" hidden>
        <input id="f-file" type="file" accept="application/pdf,image/*" hidden>
        <span class="hint">A clear photo or scan of the whole invoice. Photos are resized automatically; PDFs up to 10 MB.</span></div>
      <p class="err" id="f-err" hidden></p>
      <div class="row"><span style="flex:1"></span><button class="btn" type="reset" id="f-clear">Clear</button><button class="btn primary" type="submit" id="f-go">Submit to Flexo</button></div>
    </form></section>`;
}
function readInvoiceForm() {
  const v = id => ($("#" + id).value || "").trim();
  const out = { invoice_no: v("f-invno"), invoice_date: v("f-invdate"), po_no: v("f-po"), vatex_amount: num(v("f-vatex")), total_amount: num(v("f-total")), dr_no: v("f-dr"), dr_date: v("f-drdate") };
  const file = S.draft.file;
  const errs = [];
  const missing = [["invoice_no", "invoice number"], ["invoice_date", "invoice date"], ["po_no", "PO number"], ["vatex_amount", "VAT-exclusive amount"], ["total_amount", "total amount"], ["dr_no", "DR number"], ["dr_date", "DR date"]].filter(([k]) => out[k] === "" || out[k] == null).map(([, l]) => l);
  if (!file) missing.push("invoice file");
  if (missing.length) errs.push("Please fill in: " + missing.join(", ") + ".");
  const t = todayISO();
  if (out.invoice_date && out.invoice_date > t) errs.push("Invoice date can't be in the future.");
  if (out.dr_date && out.dr_date > t) errs.push("DR date can't be in the future.");
  if (out.vatex_amount != null && out.vatex_amount <= 0) errs.push("VAT-exclusive amount must be more than zero.");
  if (out.vatex_amount != null && out.total_amount != null && out.total_amount < out.vatex_amount) errs.push("Total amount can't be less than the VAT-exclusive amount.");
  if (S.draft.busy) errs.push("Wait a moment — the photo is still being prepared.");
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
    S.lastSubmitted = data; S.invoices.unshift(data); clearDraft(); render(); sendEmails();
  } catch (err) {
    errEl.textContent = friendly(err); errEl.hidden = false;
    if (btn.isConnected) { btn.disabled = false; btn.textContent = "Submit to Flexo"; }
  }
}

// ---------- check release dates (always Fridays) ----------
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function nextFridays(n = 10) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7)); // today if it's Friday
  const out = [];
  for (let k = 0; k < n; k++) { out.push(isoDate(d)); d.setDate(d.getDate() + 7); }
  return out;
}
const fmtFri = s => { if (!s) return "—"; const d = new Date(s + "T00:00:00"); return d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric" }); };
const fridayOptions = selected => {
  const list = nextFridays(10);
  if (selected && !list.includes(selected)) list.unshift(selected);
  return list.map((f, k) => `<option value="${f}"${(selected ? f === selected : k === 0) ? " selected" : ""}>${fmtFri(f)}${k === 0 && !selected && f === todayISO() ? " (today)" : ""}</option>`).join("");
};
function releaseCell(i, supplierView) {
  if (i.status === "scheduled") return `<div class="small"><b>Check release ${fmtFri(i.release_date)}</b></div><div class="small mono">${peso(i.release_amount)}</div>${i.release_note ? `<div class="small muted">${esc(i.release_note)}</div>` : ""}`;
  if (i.status === "paid") return `<div class="small">Paid ${fmtDate(i.paid_date)}</div><div class="small mono">${peso(i.release_amount ?? i.total_amount)}</div><div class="small muted">Ref ${esc(i.payment_ref)}</div>${i.proof_path ? `<button class="btn sm" data-proof="${esc(i.id)}" style="margin-top:4px">${supplierView ? "View proof of payment" : "Proof"}</button>` : ""}`;
  return "";
}

// ---------- supplier: my invoices ----------
function mineView() {
  const rows = S.invoices;
  const upcoming = {};
  rows.filter(i => i.status === "scheduled").forEach(i => { (upcoming[i.release_date] = upcoming[i.release_date] || { c: 0, a: 0 }); upcoming[i.release_date].c++; upcoming[i.release_date].a += Number(i.release_amount || 0); });
  const dates = Object.keys(upcoming).sort();
  return `${dates.length ? `<div class="chips">${dates.map(d => `<div class="chip" aria-pressed="false"><span class="eyebrow">Check release · ${fmtFri(d)}</span><span class="n">${peso(upcoming[d].a)}</span><span class="amt">${upcoming[d].c} invoice${upcoming[d].c === 1 ? "" : "s"}</span></div>`).join("")}</div>` : ""}
  <section class="panel" style="margin-top:20px"><div class="panel-h"><h2>My invoices</h2><span class="small muted">${rows.length} invoice${rows.length === 1 ? "" : "s"}</span><button class="btn sm" id="refresh">Refresh</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Submitted</th><th>Invoice no.</th><th>Invoice date</th><th>PO no.</th><th>DR no. / date</th><th class="num">Total</th><th>Status</th><th>Payment</th><th></th></tr></thead><tbody>
  ${rows.map(i => `<tr>
    <td class="small mono">${fmtDT(i.created_at)}</td><td class="mono">${esc(i.invoice_no)}</td><td>${fmtDate(i.invoice_date)}</td><td class="mono">${esc(i.po_no)}</td>
    <td class="mono">${esc(i.dr_no)}<div class="small muted">${fmtDate(i.dr_date)}</div></td>
    <td class="num">${peso(i.total_amount)}<div class="small muted">VAT-ex ${peso(i.vatex_amount)}</div></td>
    <td>${pill(i.status, true)}${i.status === "returned" ? `<div class="small" style="color:var(--bad)">${esc(i.return_reason)}</div><div class="small muted">Correct it and submit again.</div>` : ""}</td>
    <td>${releaseCell(i, true)}</td>
    <td><button class="btn sm" data-file="${esc(i.id)}">View invoice</button></td></tr>`).join("") || `<tr><td colspan="9" class="empty">${S.loaded.invoices ? "No invoices submitted yet." : "Loading…"}</td></tr>`}
  </tbody></table></div></section>`;
}
async function openStored(path) {
  const w = window.open("", "_blank");
  const { data, error } = await S.sb.storage.from(BUCKET).createSignedUrl(path, 600);
  if (error) { if (w) w.close(); toast(friendly(error)); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}
const openFile = inv => openStored(inv.file_path);

// ---------- staff: invoice queue ----------
function invMatches(i) {
  if (!S.q) return true;
  const q = S.q.toLowerCase();
  return [i.company_name, i.vendor_code, i.invoice_no, i.po_no, i.dr_no].join(" ").toLowerCase().includes(q);
}
const CHIPS = [["submitted", "For review"], ["approved", "Checked OK — to schedule"], ["scheduled", "Scheduled for release"], ["paid", "Paid"], ["returned", "Returned"], ["all", "All"]];
const queueRows = () => S.invoices.filter(i => (S.filter === "all" || i.status === S.filter) && invMatches(i))
  .sort((a, b) => S.filter === "scheduled" ? String(a.release_date).localeCompare(String(b.release_date)) || a.company_name.localeCompare(b.company_name) : 0);
function queueView() {
  const all = S.invoices;
  const amt = i => Number((["scheduled", "paid"].includes(i.status) && i.release_amount != null) ? i.release_amount : i.total_amount || 0);
  const agg = k => { const xs = k === "all" ? all : all.filter(i => i.status === k); return { c: xs.length, a: xs.reduce((s, i) => s + amt(i), 0) }; };
  const rows = queueRows();
  const pick = S.filter === "approved";
  if (!S.sel) S.sel = new Set();
  for (const id of [...S.sel]) if (!rows.some(r => r.id === id)) S.sel.delete(id);
  let extra = "";
  if (pick) extra = `<div class="inline-conf" style="margin:0 16px 12px">
      <span class="small" style="align-self:center"><b id="sel-n">${S.sel.size}</b> selected</span>
      <div class="field"><label for="bulk-fri">Check release (Friday)</label><select class="input" id="bulk-fri">${fridayOptions()}</select></div>
      <button class="btn primary" id="bulk-go" ${S.sel.size ? "" : "disabled"}>Schedule selected</button>
      <span class="small muted" style="align-self:center">Releases the full invoice total. To release a different amount (e.g. less EWT), open the invoice instead.</span></div>`;
  if (S.filter === "scheduled") {
    const by = {}; rows.forEach(i => { (by[i.release_date] = by[i.release_date] || { c: 0, a: 0 }); by[i.release_date].c++; by[i.release_date].a += Number(i.release_amount || 0); });
    const ds = Object.keys(by).sort();
    if (ds.length) extra = `<div class="chips" style="margin:0 16px 12px">${ds.map(d => `<div class="chip"><span class="eyebrow">${fmtFri(d)}</span><span class="n">${peso(by[d].a)}</span><span class="amt">${by[d].c} invoice${by[d].c === 1 ? "" : "s"}</span></div>`).join("")}</div>`;
  }
  const showRel = ["scheduled", "paid", "all"].includes(S.filter);
  return `<div class="chips">${CHIPS.map(([k, l]) => { const a = agg(k); return `<button class="chip" data-chip="${k}" aria-pressed="${S.filter === k}"><span class="eyebrow">${l}</span><span class="n">${a.c}</span><span class="amt">${peso(a.a)}</span></button>`; }).join("")}</div>
  <section class="panel"><div class="panel-h"><h2>${esc(CHIPS.find(c => c[0] === S.filter)[1])}</h2>
    <div class="filters"><input class="input" id="q" type="search" placeholder="Search supplier, invoice, PO, DR" value="${esc(S.q)}">
    <button class="btn sm" id="refresh">Refresh</button><button class="btn sm primary" id="export" ${rows.length ? "" : "disabled"}>Export CSV</button></div></div>
  <div style="padding-top:12px">${extra}</div>
  <div class="tbl-wrap"><table><thead><tr>${pick ? `<th><input type="checkbox" id="sel-all" aria-label="Select all" ${rows.length && rows.every(r => S.sel.has(r.id)) ? "checked" : ""}></th>` : ""}<th>Submitted</th><th>Supplier</th><th>Invoice no. / date</th><th>PO no.</th><th>DR no. / date</th><th class="num">VAT-ex</th><th class="num">Total</th><th>Status</th>${showRel ? "<th>Release / payment</th>" : ""}</tr></thead><tbody>
  ${rows.map(i => `<tr class="click" data-open="${esc(i.id)}" tabindex="0">
    ${pick ? `<td data-nopen><input type="checkbox" data-sel="${esc(i.id)}" aria-label="Select ${esc(i.invoice_no)}" ${S.sel.has(i.id) ? "checked" : ""}></td>` : ""}
    <td class="small mono">${fmtDT(i.created_at)}</td>
    <td><b>${esc(i.company_name)}</b><div class="small muted mono">${esc(i.vendor_code)}</div></td>
    <td class="mono">${esc(i.invoice_no)}<div class="small muted">${fmtDate(i.invoice_date)}</div></td>
    <td class="mono">${esc(i.po_no)}</td>
    <td class="mono">${esc(i.dr_no)}<div class="small muted">${fmtDate(i.dr_date)}</div></td>
    <td class="num">${peso(i.vatex_amount)}</td><td class="num">${peso(i.total_amount)}</td><td>${pill(i.status)}</td>
    ${showRel ? `<td data-nopen>${releaseCell(i, false)}</td>` : ""}</tr>`).join("") || `<tr><td colspan="10" class="empty">${S.loaded.invoices ? "Nothing here." : "Loading…"}</td></tr>`}
  </tbody></table></div></section>`;
}
async function bulkSchedule() {
  const fri = $("#bulk-fri").value; const ids = [...S.sel];
  if (!ids.length || !fri) return;
  const btn = $("#bulk-go"); btn.disabled = true; btn.textContent = "Scheduling…";
  let ok = 0; const failed = [];
  for (const id of ids) {
    const inv = S.invoices.find(i => i.id === id); if (!inv) continue;
    const { data, error } = await S.sb.from("invoices").update({ status: "scheduled", release_date: fri, release_amount: inv.total_amount, release_note: null }).eq("id", id).select().single();
    if (error) failed.push(inv.invoice_no); else { ok++; Object.assign(inv, data); S.sel.delete(id); }
  }
  toast(`${ok} invoice${ok === 1 ? "" : "s"} scheduled for ${fmtFri(fri)}` + (failed.length ? ` · failed: ${failed.join(", ")}` : ""));
  render(); if (ok) sendEmails();
}
function exportCSV() {
  const rows = queueRows();
  const q = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["Status", "Vendor Code", "Supplier", "Invoice No", "Invoice Date", "PO No", "VAT-Exclusive Amount", "VAT", "Total Amount", "DR No", "DR Date", "Submitted", "Check Release Date", "Release Amount", "Release Note", "Paid Date", "Payment Ref", "Return Reason"];
  const lines = [head.join(",")].concat(rows.map(i => [STATUS[i.status]?.label, i.vendor_code, i.company_name, i.invoice_no, i.invoice_date, i.po_no, i.vatex_amount, (Number(i.total_amount) - Number(i.vatex_amount)).toFixed(2), i.total_amount, i.dr_no, i.dr_date, i.created_at, i.release_date, i.release_amount, i.release_note, i.paid_date, i.payment_ref, i.return_reason].map(q).join(",")));
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
    submitted: `<button class="btn ok" id="a-approve">Mark as OK</button><button class="btn danger" id="a-return">Return to supplier…</button>`,
    approved: `<button class="btn primary" id="a-schedule">Schedule check release…</button><button class="btn" id="a-back">Move back to review</button><button class="btn danger" id="a-return">Return to supplier…</button>`,
    scheduled: `<button class="btn primary" id="a-paid">Mark as paid…</button><button class="btn" id="a-schedule">Change schedule…</button><button class="btn" id="a-unsched">Unschedule</button><button class="btn danger" id="a-return">Return to supplier…</button>`,
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
        <button class="btn sm" id="d-file">Open invoice file in new tab</button>
        <div class="panel"><div class="panel-b"><div class="eyebrow" style="margin-bottom:8px">History</div><ul class="history" id="hist"><li class="muted">Loading…</li></ul></div></div>
      </div>
      <div class="stack">
        ${notes.length ? `<div class="note warn">${notes.map(n => `<div>⚠ ${n}</div>`).join("")}</div>` : ""}
        ${inv.status === "returned" ? `<div class="note bad">Return reason: ${esc(inv.return_reason)}</div>` : ""}
        ${inv.status === "scheduled" ? `<div class="note ok">Check release <b>${fmtFri(inv.release_date)}</b> · <span class="mono">${peso(inv.release_amount)}</span>${inv.release_note ? ` · ${esc(inv.release_note)}` : ""}</div>` : ""}
        ${inv.status === "paid" ? `<div class="note ok row">Paid ${fmtDate(inv.paid_date)} · <span class="mono">${peso(inv.release_amount ?? inv.total_amount)}</span> · Ref <span class="mono">${esc(inv.payment_ref)}</span>${inv.proof_path ? `<span style="flex:1"></span><button class="btn sm" id="d-proof">View proof of payment</button>` : ""}</div>` : ""}
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
        ${inv.status === "submitted" ? `<div class="note">Check the typed values against the attached invoice and SAP (PO, GRPO/DR), then mark it OK.</div>` : ""}
        <div class="panel"><div class="panel-b stack"><div class="row">${acts}</div><div id="d-action"></div></div></div>
      </div>
    </div>
  </aside>`;
  $("#dbg").onclick = $("#dclose").onclick = () => { S.openId = null; renderDrawer(); };
  $("#dclose").focus();
  $("#d-file").onclick = () => openFile(inv);
  if ($("#d-proof")) $("#d-proof").onclick = () => openStored(inv.proof_path);
  bindDrawerActions(inv);
  // file preview + history
  S.sb.storage.from(BUCKET).createSignedUrl(inv.file_path, 600).then(({ data, error }) => {
    const pv = $("#pv"); if (!pv || S.openId !== inv.id) return;
    if (error || !data) { pv.innerHTML = `<div class="ph">Preview not available.</div>`; return; }
    pv.innerHTML = isPdf ? `<iframe src="${esc(data.signedUrl)}" title="Invoice file"></iframe>` : `<img src="${esc(data.signedUrl)}" alt="Invoice file">`;
  });
  S.sb.from("invoice_events").select("*").eq("invoice_id", inv.id).order("at", { ascending: false }).then(({ data, error }) => {
    const h = $("#hist"); if (!h || S.openId !== inv.id) return;
    const label = { submitted: "Submitted", approved: "Marked OK", scheduled: "Scheduled check release", rescheduled: "Changed check release", returned: "Returned to supplier", paid: "Marked paid" };
    h.innerHTML = error ? `<li class="muted">History not available.</li>` : (data || []).map(e => `<li><time>${fmtDT(e.at)}</time><span><b>${esc(e.actor_name)}</b> — ${esc(label[e.action] || e.action)}${e.note ? `: ${esc(e.note)}` : ""}</span></li>`).join("") || `<li class="muted">—</li>`;
  });
}
function bindDrawerActions(inv) {
  const act = $("#d-action");
  const update = async (patch, msg) => {
    const { data, error } = await S.sb.from("invoices").update(patch).eq("id", inv.id).select().single();
    if (error) { toast(friendly(error)); return false; }
    const k = S.invoices.findIndex(i => i.id === inv.id); if (k >= 0) S.invoices[k] = data;
    toast(msg); render(); sendEmails(); return true;
  };
  const confirmBox = (html, onOk, okLabel = "Confirm") => {
    act.innerHTML = `<div class="inline-conf">${html}<button class="btn primary" id="c-ok">${okLabel}</button><button class="btn ghost" id="c-cancel">Cancel</button></div>`;
    $("#c-cancel").onclick = () => (act.innerHTML = "");
    $("#c-ok").onclick = onOk;
    const first = $("input,select", act); if (first) first.focus();
  };
  if ($("#a-approve")) $("#a-approve").onclick = () => update({ status: "approved" }, "Marked as OK — ready to schedule");
  if ($("#a-back")) $("#a-back").onclick = () => update({ status: "submitted" }, "Moved back to review");
  if ($("#a-unsched")) $("#a-unsched").onclick = () => update({ status: "approved" }, "Schedule removed");
  if ($("#a-return")) $("#a-return").onclick = () => confirmBox(
    `<div class="field" style="flex:1;min-width:220px"><label for="c-reason">Reason (shown to the supplier)</label><input class="input" id="c-reason"></div>`,
    () => { const r = $("#c-reason").value.trim(); if (!r) return toast("Enter a reason."); update({ status: "returned", return_reason: r }, "Returned to supplier"); });
  if ($("#a-schedule")) $("#a-schedule").onclick = () => confirmBox(
    `<div class="field"><label for="c-fri">Check release (Friday)</label><select class="input" id="c-fri">${fridayOptions(inv.status === "scheduled" ? inv.release_date : null)}</select></div>
     <div class="field"><label for="c-amt">Amount to be released (₱)</label><input class="input num" id="c-amt" inputmode="decimal" value="${Number(inv.release_amount ?? inv.total_amount).toFixed(2)}" style="width:150px"></div>
     <div class="field" style="flex:1;min-width:160px"><label for="c-note">Note to supplier (optional)</label><input class="input" id="c-note" placeholder="e.g. less 1% EWT" value="${esc(inv.release_note || "")}"></div>`,
    () => {
      const a = num($("#c-amt").value);
      if (a == null || a <= 0) return toast("Enter the amount to be released.");
      if (a > Number(inv.total_amount)) return toast("The release amount can't be more than the invoice total.");
      update({ status: "scheduled", release_date: $("#c-fri").value, release_amount: a, release_note: $("#c-note").value.trim() || null }, `Check release set for ${fmtFri($("#c-fri").value)}`);
    }, "Save schedule");
  if ($("#a-paid")) $("#a-paid").onclick = () => confirmBox(
    `<div class="field"><label for="c-date">Payment date</label><input class="input" type="date" id="c-date" value="${inv.release_date && inv.release_date <= todayISO() ? inv.release_date : todayISO()}" max="${todayISO()}"></div>
     <div class="field" style="min-width:170px"><label for="c-ref">Check no. / transfer ref.</label><input class="input mono" id="c-ref"></div>
     <div class="field" style="flex:1;min-width:220px"><label for="c-proof">Proof of payment (PDF, JPG, PNG)</label><input class="input" type="file" id="c-proof" accept="application/pdf,image/*"></div>`,
    async () => {
      const ref = $("#c-ref").value.trim(), d = $("#c-date").value, raw = $("#c-proof").files[0];
      if (!d || !ref) return toast("Enter the payment date and check / reference no.");
      if (!raw) return toast("Attach the proof of payment.");
      let f; try { f = await prepareUpload(raw); } catch (err) { return toast(err.message); }
      const btn = $("#c-ok"); btn.disabled = true; btn.textContent = "Uploading…";
      const path = `payments/${inv.id}/${Date.now()}-${f.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "proof"}`;
      const up = await S.sb.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false });
      if (up.error) { toast(friendly(up.error)); btn.disabled = false; btn.textContent = "Mark paid"; return; }
      const done = await update({ status: "paid", paid_date: d, payment_ref: ref, proof_path: path, proof_name: f.name }, "Marked as paid");
      if (!done) { await S.sb.storage.from(BUCKET).remove([path]); if (btn.isConnected) { btn.disabled = false; btn.textContent = "Mark paid"; } }
    }, "Mark paid");
}

// ---------- staff: supplier accounts ----------
function accountsView() {
  const all = S.profiles;
  const groups = { pending: p => p.status === "pending", approved: p => p.status === "approved", inactive: p => ["rejected", "disabled"].includes(p.status), all: () => true };
  const labels = { pending: "Pending approval", approved: "Approved", inactive: "Rejected / disabled", all: "All" };
  const rows = all.filter(groups[S.acctFilter]);
  const canEdit = p => isAdmin() || (p.role === "supplier" && p.requested_role !== "staff");
  return `<div class="chips">${Object.keys(groups).map(k => `<button class="chip" data-acct="${k}" aria-pressed="${S.acctFilter === k}"><span class="eyebrow">${labels[k]}</span><span class="n">${all.filter(groups[k]).length}</span></button>`).join("")}</div>
  <section class="panel"><div class="panel-h"><h2>${labels[S.acctFilter]}</h2><span class="small muted">Approve a supplier by entering their SAP vendor code (CardCode).</span><button class="btn sm" id="refresh">Refresh</button></div>
  <div class="tbl-wrap"><table><thead><tr><th>Registered</th><th>Company / TIN</th><th>Contact</th><th>Role</th><th>Status</th><th>SAP vendor code</th><th></th></tr></thead><tbody>
  ${rows.map(p => { const me = p.id === S.profile.id; const ed = canEdit(p) && !me; return `<tr data-pid="${esc(p.id)}">
    <td class="small mono">${fmtDT(p.created_at)}</td>
    <td><b>${esc(p.company_name)}</b><div class="small muted mono">${esc(p.tin)}</div></td>
    <td>${esc(p.contact_name)}<div class="small muted">${esc(p.email)}</div><div class="small muted">${esc(p.phone)}</div></td>
    <td>${isAdmin() && !me ? `<select class="input" data-role style="width:auto">${["supplier", "staff", "admin"].map(r => `<option value="${r}"${(p.status === "pending" && p.requested_role === "staff" ? "staff" : p.role) === r ? " selected" : ""}>${r}</option>`).join("")}</select>` : esc(p.role)}${p.requested_role === "staff" && p.role === "supplier" ? `<div><span class="pill p-approved" style="margin-top:4px">Staff request</span></div>` : ""}</td>
    <td>${acctPill(p.status)}${p.status_note ? `<div class="small muted">${esc(p.status_note)}</div>` : ""}</td>
    <td>${p.role === "supplier" && !(p.requested_role === "staff" && p.status === "pending") ? (ed ? `<input class="input mono" data-vc value="${esc(p.vendor_code || "")}" placeholder="e.g. V-00123" style="width:130px">` : `<span class="mono">${esc(p.vendor_code || "—")}</span>`) : `<span class="muted small">n/a</span>`}</td>
    <td>${ed ? `<div class="row">
      ${p.status !== "approved" ? `<button class="btn sm ok" data-do="approve">Approve</button>` : `<button class="btn sm" data-do="save">Save</button>`}
      ${p.status === "pending" ? `<button class="btn sm danger" data-do="reject">Reject</button>` : ""}
      ${p.status === "approved" ? `<button class="btn sm danger" data-do="disable">Disable</button>` : ""}
    </div>` : `<span class="small muted">${me ? "You" : ""}</span>`}</td></tr>`; }).join("") || `<tr><td colspan="7" class="empty">${S.loaded.profiles ? "No accounts here." : "Loading…"}</td></tr>`}
  </tbody></table></div>
  <div class="panel-b"><div class="note">New staff request access on the staff page (<a href="${esc(STAFF_URL)}">${esc(STAFF_URL)}</a>) with their ${STAFF_DOMAIN} email; an admin approves them here with role <b>staff</b>.</div></div></section>`;
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
  toast({ approve: "Account approved", reject: "Account rejected", disable: "Account disabled", save: "Saved" }[what]); render(); sendEmails();
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
    $("#f-clear").onclick = ev => { ev.preventDefault(); clearDraft(); render(); };
    $$("[data-draft]", app).forEach(i => i.addEventListener("input", () => { S.draft.fields[i.id] = i.value; saveDraft(); }));
    calc();
    const pick = async input => {
      const raw = input.files[0]; input.value = ""; if (!raw) return;
      S.draft.busy = true; S.draft.lostFile = ""; render();
      try {
        const file = await prepareUpload(raw);
        if (S.draft.preview) URL.revokeObjectURL(S.draft.preview);
        S.draft.file = file; S.draft.preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      } catch (err) { S.draft.busy = false; render(); const e = $("#f-err"); if (e) { e.textContent = err.message; e.hidden = false; } return; }
      S.draft.busy = false; saveDraft(); render();
    };
    $("#f-cam").onchange = () => pick($("#f-cam"));
    $("#f-file").onchange = () => pick($("#f-file"));
    if ($("#f-remove")) $("#f-remove").onclick = () => { if (S.draft.preview) URL.revokeObjectURL(S.draft.preview); S.draft.file = null; S.draft.preview = null; saveDraft(); render(); };
  }
  if ($("#new-inv")) $("#new-inv").onclick = () => { S.lastSubmitted = null; render(); };
  if ($("#go-mine")) $("#go-mine").onclick = () => { S.lastSubmitted = null; S.tab = "mine"; render(); };
  $$("[data-file]", app).forEach(b => (b.onclick = () => { const i = S.invoices.find(x => x.id === b.dataset.file); if (i) openFile(i); }));
  if ($("#refresh")) $("#refresh").onclick = () => { if (S.tab === "accounts") loadProfiles(); else loadInvoices(); };
  $$("[data-chip]", app).forEach(b => (b.onclick = () => { S.filter = b.dataset.chip; render(); }));
  if ($("#q")) $("#q").oninput = e => { S.q = e.target.value; clearTimeout(bindView.t); bindView.t = setTimeout(render, 200); };
  if ($("#export")) $("#export").onclick = exportCSV;
  $$("[data-open]", app).forEach(r => { const open = e => { if (e && e.target.closest("[data-nopen]")) return; S.openId = r.dataset.open; renderDrawer(); }; r.onclick = open; r.onkeydown = e => { if (e.key === "Enter" && e.target === r) open(); }; });
  $$("[data-proof]", app).forEach(b => (b.onclick = e => { e.stopPropagation(); const i = S.invoices.find(x => x.id === b.dataset.proof); if (i && i.proof_path) openStored(i.proof_path); }));
  const selCount = () => { if ($("#sel-n")) $("#sel-n").textContent = S.sel.size; if ($("#bulk-go")) $("#bulk-go").disabled = !S.sel.size; };
  $$("[data-sel]", app).forEach(c => (c.onchange = () => { c.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); selCount(); }));
  if ($("#sel-all")) $("#sel-all").onchange = e => { $$("[data-sel]", app).forEach(c => { c.checked = e.target.checked; c.checked ? S.sel.add(c.dataset.sel) : S.sel.delete(c.dataset.sel); }); selCount(); };
  if ($("#bulk-go")) $("#bulk-go").onclick = bulkSchedule;
  $$("[data-acct]", app).forEach(b => (b.onclick = () => { S.acctFilter = b.dataset.acct; render(); }));
  $$("[data-do]", app).forEach(b => (b.onclick = () => accountAction(b.closest("tr"), b.dataset.do)));
}

document.addEventListener("keydown", e => { if (e.key === "Escape" && S.openId) { S.openId = null; renderDrawer(); } });
boot();
})();
