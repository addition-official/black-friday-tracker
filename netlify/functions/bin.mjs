// Server-side proxy for jsonbin.io.
// The browser calls /api/bin; this function adds the secret key and forwards the request.
// The key lives in Netlify environment variables, never in the page source.
//
// Environment variables (Project configuration > Environment variables):
//   JSONBIN_BIN_ID       required  - the bin id
//   JSONBIN_ACCESS_KEY   preferred - a jsonbin Access Key limited to read + update
//   JSONBIN_MASTER_KEY   fallback  - used only if no access key is set
//   TRACKER_PASSCODE     optional  - if set, the page must send this passcode to read or save

const API = "https://api.jsonbin.io/v3/b/";
const MAX_BYTES = 1_000_000; // refuse absurdly large saves

const env = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "").trim();

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

export default async (req) => {
  const binId = env("JSONBIN_BIN_ID");
  const accessKey = env("JSONBIN_ACCESS_KEY");
  const masterKey = env("JSONBIN_MASTER_KEY");
  const passcode = env("TRACKER_PASSCODE");

  if (!binId || (!accessKey && !masterKey)) {
    return json({ error: "server not configured: missing JSONBIN env vars" }, 500);
  }

  if (passcode && req.headers.get("x-tracker-passcode") !== passcode) {
    return json({ error: "wrong passcode" }, 401);
  }

  const authHeader = accessKey ? { "X-Access-Key": accessKey } : { "X-Master-Key": masterKey };

  try {
    if (req.method === "GET") {
      const r = await fetch(`${API}${binId}/latest`, { headers: authHeader });
      const text = await r.text();
      // Never pass jsonbin's 401/403 straight through: the page reserves 401 for "wrong passcode".
      if (!r.ok) {
        let detail = text;
        try { detail = JSON.parse(text).message || text; } catch {}
        return json({ error: "jsonbin: " + detail, status: r.status }, 502);
      }
      return new Response(text, {
        status: r.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }

    if (req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_BYTES) return json({ error: "payload too large" }, 413);

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.lists !== "object") {
        return json({ error: "unexpected data shape" }, 400);
      }

      const r = await fetch(`${API}${binId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeader },
        body,
      });
      if (!r.ok) {
        let detail = await r.text();
        try { detail = JSON.parse(detail).message || detail; } catch {}
        return json({ error: "jsonbin: " + detail, status: r.status }, 502);
      }
      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405, { allow: "GET, PUT" });
  } catch (e) {
    return json({ error: "could not reach jsonbin", detail: String(e) }, 502);
  }
};

export const config = { path: "/api/bin" };
