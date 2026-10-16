export type Crumb = { lat: number; lng: number; at: number };

/** Ignore GPS jitter closer than this so a sitting truck does not fill the trail. */
export const CRUMB_MIN_METERS = 12;

export function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const lat = (a.lat - b.lat) * 111_320;
  const lng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(lat, lng);
}

/** Keep every point. Age does not drop a crumb. Points within 12 meters of the previous one are skipped. */
export function thinCrumbs(points: Crumb[], now = Date.now()): Crumb[] {
  const fresh = points
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Number.isFinite(point.at) && point.at <= now + 24 * 60 * 60 * 1000)
    .sort((a, b) => a.at - b.at);
  const out: Crumb[] = [];
  for (const point of fresh) {
    const last = out[out.length - 1];
    if (last && metersBetween(last, point) < CRUMB_MIN_METERS) continue;
    out.push(point);
  }
  return out;
}

export function appendCrumb(trail: Crumb[], next: Crumb, now = Date.now()): Crumb[] {
  return thinCrumbs([...trail, next], now);
}
