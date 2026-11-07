// Live package tracking via Ship24.
// The browser calls POST /api/track with { trackingNumber }; this adds the secret key and asks Ship24.
//
// Environment variables (Project configuration > Environment variables):
//   SHIP24_API_KEY     required - from ship24.com (starts with apik_)
//   TRACKER_PASSCODE   optional - same passcode as the list
//
// Ship24's /trackers/track is idempotent: asking again about the same tracking number
// reuses the existing tracker (no extra quota) and returns fresh results.

const API = "https://api.ship24.com/public/v1/trackers/track";
// Netlify stops functions after ~10s. Ship24's very first lookup of a new number can take
// up to a minute, so give up a bit before Netlify does and let the page try again later.
const TIMEOUT_MS = 8500;

const env = (k) => (globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "").trim();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// Human wording for Ship24's statusMilestone values.
const LABELS = {
  pending: "waiting for the carrier",
  info_received: "label created",
  in_transit: "on the way",
  out_for_delivery: "out for delivery",
  failed_attempt: "delivery attempt failed",
  available_for_pickup: "ready for pickup",
  delivered: "delivered",
  exception: "problem with delivery",
};

export function summarize(tracking) {
  const shipment = tracking?.shipment || {};
  const milestone = shipment.statusMilestone || "pending";
  const events = Array.isArray(tracking?.events) ? tracking.events : [];
  // Ship24 returns newest first, but sort defensively by date then order.
  const sorted = [...events].sort((a, b) => {
    const d = String(b.occurrenceDatetime || "").localeCompare(String(a.occurrenceDatetime || ""));
    return d !== 0 ? d : (b.order ?? 0) - (a.order ?? 0);
  });
  const ev = (e) => ({
    text: e.status || LABELS[e.statusMilestone] || "",
    location: e.location || "",
    when: e.occurrenceDatetime || "",
    milestone: e.statusMilestone || "",
  });
  return {
    milestone,
    label: LABELS[milestone] || milestone.replace(/_/g, " "),
    eta: shipment.delivery?.estimatedDeliveryDate || "",
    deliveredAt: tracking?.statistics?.timestamps?.deliveredDatetime || "",
    courier: sorted.find((e) => e.courierCode)?.courierCode || "",
    latest: sorted[0] ? ev(sorted[0]) : null,
    events: sorted.slice(0, 8).map(ev),
  };
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const passcode = env("TRACKER_PASSCODE");
  if (passcode && req.headers.get("x-tracker-passcode") !== passcode) {
    return json({ error: "wrong passcode" }, 401);
  }

  const key = env("SHIP24_API_KEY");
  if (!key) return json({ error: "tracking isn't set up yet (SHIP24_API_KEY missing)", setup: true }, 503);

  let trackingNumber = "";
  try {
    trackingNumber = String((await req.json()).trackingNumber || "").trim().replace(/\s+/g, "");
  } catch {}
  if (trackingNumber.length < 5 || trackingNumber.length > 50) {
    return json({ error: "that doesn't look like a tracking number" }, 400);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      // keep the body identical every time so Ship24 reuses the same tracker (no extra quota)
      body: JSON.stringify({ trackingNumber }),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}

    if (!r.ok) {
      const msg = body?.errors?.[0]?.message || body?.message || text.slice(0, 200) || `status ${r.status}`;
      // never pass Ship24's 401/403 through: the page reserves 401 for "wrong passcode"
      const status = r.status === 429 ? 429 : r.status === 400 ? 400 : 502;
      return json({ error: "ship24: " + msg, ship24Status: r.status }, status);
    }

    const tracking = body?.data?.trackings?.[0];
    if (!tracking) return json({ pending: true, label: LABELS.pending, milestone: "pending" });
    return json(summarize(tracking));
  } catch (e) {
    if (e?.name === "AbortError") {
      // first lookup still running at Ship24; the tracker exists now, so next time is instant
      return json({ pending: true, slow: true, milestone: "pending", label: "checking with the carrier…" });
    }
    return json({ error: "couldn't reach ship24", detail: String(e) }, 502);
  } finally {
    clearTimeout(timer);
  }
};

export const config = { path: "/api/track" };
