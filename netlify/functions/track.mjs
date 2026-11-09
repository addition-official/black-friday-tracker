// Live package tracking via 17TRACK (API v2.4).
// The browser calls POST /api/track with { trackingNumber }; this adds the secret key and asks 17TRACK.
//
// Environment variables (Project configuration > Environment variables):
//   SEVENTEENTRACK_API_KEY  required - 17TRACK API dashboard > Settings > Security > Key
//   TRACKER_PASSCODE        optional - same passcode as the list
//
// How credits are used (17TRACK charges 1 credit per tracking number, once):
//   1. /gettrackinfo  - read what 17TRACK already knows. Free.
//   2. /register      - only if 17TRACK has never seen this number. Costs 1 credit.
// After registering, 17TRACK re-checks the package by itself every 6-12 hours at no extra cost,
// so reading it again later is always free.
//
// The page never sends Amazon (TBA) or USPS numbers here: 17TRACK can't read Amazon's own
// deliveries and USPS restricts third-party tracking, so those would only waste credits.

const API = "https://api.17track.net/track/v2.4";
const TIMEOUT_MS = 8500;   // Netlify stops functions after ~10s

const env = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "").trim();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// 17TRACK main statuses -> the app's milestones + human wording
const MAP = {
  NotFound:           ["pending", "waiting for the carrier"],
  InfoReceived:       ["info_received", "label created"],
  InTransit:          ["in_transit", "on the way"],
  Expired:            ["exception", "no updates for a while"],
  AvailableForPickup: ["available_for_pickup", "ready for pickup"],
  OutForDelivery:     ["out_for_delivery", "out for delivery"],
  DeliveryFailure:    ["failed_attempt", "delivery attempt failed"],
  Delivered:          ["delivered", "delivered"],
  Exception:          ["exception", "problem with delivery"],
};

export function summarize(item) {
  const info = item?.track_info || {};
  const status = info.latest_status?.status || "NotFound";
  const [milestone, label] = MAP[status] || ["pending", String(status).toLowerCase()];
  const providers = Array.isArray(info.tracking?.providers) ? info.tracking.providers : [];
  const events = providers
    .flatMap((p) => (Array.isArray(p.events) ? p.events : []))
    .map((e) => ({
      text: e.description_translation?.description || e.description || "",
      location: e.location || "",
      when: e.time_iso || e.time_utc || "",
      sort: e.time_utc || e.time_iso || "",
    }))
    .sort((a, b) => String(b.sort).localeCompare(String(a.sort)))
    .map(({ sort, ...e }) => e);
  const latest = info.latest_event
    ? { text: info.latest_event.description || "", location: info.latest_event.location || "", when: info.latest_event.time_iso || "" }
    : events[0] || null;
  const eta = info.time_metrics?.estimated_delivery_date || {};
  return {
    milestone,
    label,
    eta: milestone === "delivered" ? "" : (eta.to || eta.from || ""),
    deliveredAt: milestone === "delivered" ? (latest?.when || "") : "",
    courier: providers[0]?.provider?.name || "",
    latest,
    events: events.slice(0, 8),
  };
}

async function call(path, key, body, signal) {
  const r = await fetch(`${API}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "17token": key },
    body: JSON.stringify(body),
    signal,
  });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  return { ok: r.ok, status: r.status, data, text };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const passcode = env("TRACKER_PASSCODE");
  if (passcode && req.headers.get("x-tracker-passcode") !== passcode) {
    return json({ error: "wrong passcode" }, 401);
  }

  const key = env("SEVENTEENTRACK_API_KEY");
  if (!key) return json({ error: "tracking isn't set up yet (SEVENTEENTRACK_API_KEY missing)", setup: true }, 503);

  let number = "";
  try { number = String((await req.json()).trackingNumber || "").trim().replace(/\s+/g, "").toUpperCase(); } catch {}
  if (number.length < 5 || number.length > 50) return json({ error: "that doesn't look like a tracking number" }, 400);
  // safety net: never spend credits on numbers 17TRACK can't track for us
  if (/^TB[ACM]/.test(number) || /^9[2-5]\d{18,24}$/.test(number) || /^[A-Z]{2}\d{9}US$/.test(number)) {
    return json({ error: "amazon and usps numbers aren't live-tracked; use the carrier button", skipped: true }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const fail = (r) => {
    const msg = r.data?.data?.errors?.[0]?.message || r.data?.message || r.text.slice(0, 200) || `status ${r.status}`;
    // never pass an auth failure through as 401: the page reserves 401 for "wrong passcode"
    return json({ error: "17track: " + msg }, r.status === 429 ? 429 : 502);
  };
  try {
    // 1. free: does 17TRACK already know this number?
    const got = await call("gettrackinfo", key, [{ number }], ctrl.signal);
    if (!got.ok || got.data.code !== 0) return fail(got);
    const found = got.data.data?.accepted?.[0];
    if (found) {
      // registered but the carrier hasn't answered yet
      if (!found.track_info) return json({ pending: true, slow: true, milestone: "pending", label: "checking with the carrier…" });
      return json(summarize(found));
    }

    const rejected = got.data.data?.rejected?.[0];
    const code = rejected?.error?.code;
    if (code !== -18019902) {   // anything other than "not registered yet"
      return json({ error: "17track: " + (rejected?.error?.message || "unknown error"), code }, 502);
    }

    // 2. first time we see this number: register it (1 credit, once)
    const reg = await call("register", key, [{ number }], ctrl.signal);
    if (!reg.ok || reg.data.code !== 0) return fail(reg);
    const rej = reg.data.data?.rejected?.[0];
    if (rej && rej.error?.code !== -18019901) {   // -18019901 = already registered, which is fine
      const c = rej.error?.code;
      const why = c === -18019903 ? "17track couldn't tell which carrier this is"
        : c === -18019908 ? "out of 17track credits"
        : c === -18019907 ? "17track daily limit reached, try tomorrow"
        : rej.error?.message || "couldn't register";
      return json({ error: why, code: c }, 502);
    }
    // results usually arrive within seconds; the page asks again shortly
    return json({ pending: true, slow: true, milestone: "pending", label: "checking with the carrier…" });
  } catch (e) {
    if (e?.name === "AbortError") return json({ pending: true, slow: true, milestone: "pending", label: "checking with the carrier…" });
    return json({ error: "couldn't reach 17track", detail: String(e) }, 502);
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: "/api/track" };
