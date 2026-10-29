// Supabase Edge Function: send-auth-email
// Supabase Auth "Send Email" hook: sends password-reset (and other account) emails
// through Microsoft Graph instead of Supabase's built-in mailer.
// Deploy with JWT verification OFF — Supabase Auth signs each call with the hook secret instead.
//
// Secrets: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MAIL_SENDER (same as "notify"), and
//   SEND_EMAIL_HOOK_SECRET   the secret shown when you create the hook (starts with "v1,whsec_")
import { Webhook } from "npm:standardwebhooks@1.0.0";

const env = (k: string) => Deno.env.get(k) ?? "";

let token: { value: string; exp: number } | null = null;
async function graphToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${env("MS_TENANT_ID")}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("MS_CLIENT_ID"), client_secret: env("MS_CLIENT_SECRET"), scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }),
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
    body: JSON.stringify({ message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }),
  });
  if (!res.ok) throw new Error(`Graph sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const TEXT: Record<string, [string, string, string]> = {
  recovery: ["Reset your Flexo supplier portal password", "We received a request to reset your password. Click the button to choose a new one. If you didn't ask for this, you can ignore this email.", "Set a new password"],
  signup: ["Confirm your email for the Flexo supplier portal", "Please confirm your email address to finish signing up.", "Confirm email"],
  magiclink: ["Your Flexo supplier portal sign-in link", "Click the button to sign in.", "Sign in"],
  invite: ["You're invited to the Flexo supplier portal", "Click the button to accept the invitation and set up your account.", "Accept invitation"],
  email_change: ["Confirm your new email address", "Click the button to confirm your new email address for the Flexo supplier portal.", "Confirm new email"],
};
export function compose(email: string, d: { token_hash: string; email_action_type: string; redirect_to: string; site_url: string; token?: string }) {
  const [subject, intro, button] = TEXT[d.email_action_type] ?? ["Flexo supplier portal", "Click the button to continue.", "Continue"];
  const link = `${env("SUPABASE_URL")}/auth/v1/verify?token=${encodeURIComponent(d.token_hash)}&type=${encodeURIComponent(d.email_action_type)}&redirect_to=${encodeURIComponent(d.redirect_to || d.site_url)}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#15232B;max-width:560px">
  <div style="border-bottom:3px solid #0E6B5C;padding:8px 0 10px;margin-bottom:16px"><b style="color:#0E6B5C">Flexo Manufacturing Corporation</b> · Supplier Invoice Portal</div>
  <h2 style="font-size:18px;margin:0 0 8px">${esc(subject)}</h2><p style="margin:0 0 16px">${esc(intro)}</p>
  <p style="margin:0 0 16px"><a href="${esc(link)}" style="background:#0E6B5C;color:#fff;text-decoration:none;padding:9px 16px;border-radius:6px;display:inline-block">${esc(button)}</a></p>
  ${d.token ? `<p style="color:#6B7A80;font-size:12px">Or enter this code: <b>${esc(d.token)}</b></p>` : ""}
  <p style="color:#6B7A80;font-size:12px;margin:16px 0 0">This link works once and expires soon. Automatic message — please do not reply.</p></div>`;
  return { to: email, subject, html };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    const payload = await req.text();
    let data: { user: { email: string }; email_data: { token_hash: string; email_action_type: string; redirect_to: string; site_url: string; token?: string } };
    try {
      const wh = new Webhook(env("SEND_EMAIL_HOOK_SECRET").replace("v1,whsec_", ""));
      data = wh.verify(payload, Object.fromEntries(req.headers)) as typeof data;
    } catch (_e) {
      return new Response(JSON.stringify({ error: { http_code: 401, message: "Invalid signature" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    try {
      const m = compose(data.user.email, data.email_data);
      await sendMail(m.to, m.subject, m.html);
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: { http_code: 500, message: "Email could not be sent" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  });
}
