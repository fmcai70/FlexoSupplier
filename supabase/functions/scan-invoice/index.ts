// Supabase Edge Function: scan-invoice
// Reads an uploaded invoice (page images and/or PDF text in the prompt) with
// Claude and returns the extracted fields as JSON. The Anthropic API key stays
// on the server as a Supabase secret.
//
// Deploy:
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//   supabase functions deploy scan-invoice --no-verify-jwt
import Anthropic from "npm:@anthropic-ai/sdk@^0.133.0";

const MODEL = Deno.env.get("SCAN_MODEL") ?? "claude-opus-5-5";
const EFFORT = Deno.env.get("SCAN_EFFORT") ?? "medium";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const MAX_IMAGES = 3;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (status: number, code: string, message = code) => reply(status, { error: { code, message } });

// Pull the first JSON object out of the model's text reply.
function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(start, end + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  let prompt: string;
  let images: { media_type: string; data: string }[];
  try {
    const body = await req.json();
    prompt = String(body?.prompt ?? "");
    images = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES) : [];
  } catch {
    return fail(400, "bad_request", "Body must be JSON");
  }
  if (!prompt || prompt.length > 60000) return fail(400, "bad_request", "Missing or oversized prompt");
  if (images.some((i) => !IMAGE_TYPES.has(i?.media_type) || typeof i?.data !== "string")) {
    return fail(400, "image_rejected", "Unsupported image");
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...images.map((i) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: i.media_type as "image/jpeg", data: i.data },
    })),
    { type: "text", text: prompt },
  ];

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT as "low" | "medium" | "high" },
      // On a safety decline, let the API retry on a fallback model automatically.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") return fail(422, "refused");
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    try {
      return reply(200, { result: parseJsonObject(text) });
    } catch {
      return fail(502, "invalid_json", "The scan result was not valid JSON");
    }
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return fail(429, "rate_limited");
    if (e instanceof Anthropic.BadRequestError) return fail(400, "image_rejected", e.message);
    if (e instanceof Anthropic.AuthenticationError) return fail(500, "sampling_disabled", "ANTHROPIC_API_KEY is missing or invalid");
    if (e instanceof Anthropic.APIError) return fail(502, "upstream_error", e.message);
    return fail(500, "error", String(e));
  }
});
