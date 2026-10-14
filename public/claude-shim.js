// claude-shim.js
// The portal was built as a claude.ai artifact and talks to its runtime through
// `claude.use("db" | "assets" | "downloads" | "sample")`. This file provides the
// same API on top of Supabase so the portal code can run on any static host.
//
//   db        -> table public.docs (collection, id, data jsonb) + Realtime
//   assets    -> Storage bucket "invoice-files"
//   downloads -> plain browser download
//   sample    -> Edge Function "scan-invoice" (calls the Claude API server-side)
(() => {
  "use strict";
  const cfg = window.FLEXO_CONFIG || {};
  const ready = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  const sb = ready ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  const BUCKET = cfg.storageBucket || "invoice-files";

  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const wrapErr = (e) => {
    if (!e) return e;
    if (e.code && /^(unavailable|quota_exceeded|cancelled)$/.test(e.code)) return e;
    const msg = e.message || String(e);
    // PostgREST / fetch failures surface as plain errors; the portal retries on "unavailable".
    if (/fetch|network|timeout|503|502/i.test(msg)) return err("unavailable", msg);
    return err(e.code || "error", msg);
  };
  const splitPath = (path) => {
    const i = String(path).indexOf("/");
    if (i < 1) throw err("invalid_path", "Document path must be collection/id: " + path);
    return [path.slice(0, i), path.slice(i + 1)];
  };
  const snapDoc = (row) => ({ id: row.id, exists: true, data: () => row.data || {} });

  // ---------- listeners ----------
  // Every listener refetches its collection (debounced) when Realtime reports a
  // change, and immediately after this browser writes to it.
  const listeners = new Map(); // collection -> Set<refresh fn>
  const channels = new Map();  // collection -> realtime channel
  function poke(collection) { (listeners.get(collection) || []).forEach((f) => f()); }
  function listen(collection, refresh) {
    if (!listeners.has(collection)) listeners.set(collection, new Set());
    listeners.get(collection).add(refresh);
    if (!channels.has(collection)) {
      const ch = sb.channel("docs-" + collection)
        .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "collection=eq." + collection }, () => poke(collection))
        .subscribe();
      channels.set(collection, ch);
    }
    return () => {
      const set = listeners.get(collection);
      set && set.delete(refresh);
      if (set && !set.size) { const ch = channels.get(collection); ch && sb.removeChannel(ch); channels.delete(collection); listeners.delete(collection); }
    };
  }
  function debounced(fn, ms = 250) {
    let t = null, running = false, again = false;
    const run = async () => {
      if (running) { again = true; return; }
      running = true;
      try { await fn(); } finally { running = false; if (again) { again = false; schedule(); } }
    };
    const schedule = () => { clearTimeout(t); t = setTimeout(run, ms); };
    return { schedule, now: run };
  }

  // ---------- db ----------
  function docRef(path) {
    const [collection, id] = splitPath(path);
    const ref = {
      id,
      async get() {
        const { data, error } = await sb.from("docs").select("id,data").eq("collection", collection).eq("id", id).maybeSingle();
        if (error) throw wrapErr(error);
        return data ? snapDoc(data) : { id, exists: false, data: () => undefined };
      },
      async set(body) {
        const { error } = await sb.from("docs").upsert({ collection, id, data: body, updated_at: new Date().toISOString() });
        if (error) throw wrapErr(error);
        poke(collection);
      },
      async update(patch) {
        // Top-level merge, like Firestore's update(); done in SQL so it is atomic.
        const { data, error } = await sb.rpc("doc_merge", { p_collection: collection, p_id: id, p_patch: patch });
        if (error) throw wrapErr(error);
        if (data === false) throw err("not_found", "No document at " + path);
        poke(collection);
      },
      async delete() {
        const { error } = await sb.from("docs").delete().eq("collection", collection).eq("id", id);
        if (error) throw wrapErr(error);
        poke(collection);
      },
      onSnapshot(next, onError) {
        const d = debounced(async () => {
          try { next(await ref.get()); } catch (e) { onError && onError(wrapErr(e)); }
        });
        const off = listen(collection, d.schedule);
        d.now();
        return off;
      },
    };
    return ref;
  }
  function collectionRef(collection, max = 1000) {
    const q = {
      limit(n) { return collectionRef(collection, n); },
      async get() {
        const { data, error } = await sb.from("docs").select("id,data").eq("collection", collection).order("id").limit(max);
        if (error) throw wrapErr(error);
        const docs = (data || []).map(snapDoc);
        return { docs, size: docs.length, empty: !docs.length };
      },
      doc(id) { return docRef(collection + "/" + id); },
      onSnapshot(next, onError) {
        const d = debounced(async () => {
          try { next(await q.get()); } catch (e) { onError && onError(wrapErr(e)); }
        });
        const off = listen(collection, d.schedule);
        d.now();
        return off;
      },
    };
    return q;
  }
  const db = { collection: (name) => collectionRef(name), doc: (path) => docRef(path) };

  // ---------- assets ----------
  const assets = {
    async upload(file, opts) {
      const safe = String(file.name || "invoice").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
      const path = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + "/" + safe;
      const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: (opts && opts.type) || file.type || "application/octet-stream", upsert: false });
      if (error) throw wrapErr(error);
      return { id: path };
    },
    // Short-lived link to the original file (bucket is private).
    async url(id, seconds = 600) {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(id, seconds);
      if (error) throw wrapErr(error);
      return data.signedUrl;
    },
  };

  // ---------- downloads ----------
  const downloads = {
    async save({ filename, data, type }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: type || "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return { status: "saved" };
    },
  };

  // ---------- sample (invoice scanner) ----------
  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
  const MAX_IMAGES = cfg.scanMaxPages || 3;
  const sample = {
    async limits() { return { images: { maxCount: MAX_IMAGES } }; },
    async json(prompt, opts = {}) {
      const images = [];
      for (const b of (opts.images || []).slice(0, MAX_IMAGES)) images.push({ media_type: b.type || "image/jpeg", data: await blobToBase64(b) });
      let res;
      try {
        res = await fetch(cfg.supabaseUrl.replace(/\/$/, "") + "/functions/v1/" + (cfg.scanFunction || "scan-invoice"), {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: cfg.supabaseAnonKey, Authorization: "Bearer " + cfg.supabaseAnonKey },
          body: JSON.stringify({ prompt, images }),
          signal: opts.signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw err("cancelled");
        throw err("unavailable", e && e.message);
      }
      let body = null;
      try { body = await res.json(); } catch (e) { /* handled below */ }
      if (!res.ok || !body || body.error) {
        const code = (body && body.error && body.error.code) || (res.status === 429 ? "rate_limited" : res.status === 404 ? "sampling_disabled" : "error");
        throw err(code, body && body.error && body.error.message);
      }
      return body.result;
    },
  };

  // ---------- claude.use ----------
  window.claude = window.claude || {};
  window.claude.use = async (name) => {
    if (!sb) throw err("not_configured", "Supabase is not configured. Fill in config.js.");
    if (name === "db") return db;
    if (name === "assets") return assets;
    if (name === "downloads") return downloads;
    if (name === "sample") return cfg.scanEnabled === false ? null : sample;
    throw err("unknown_capability", name);
  };
})();
