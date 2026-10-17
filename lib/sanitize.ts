export function safeGroup(input: unknown) {
  const raw = typeof input === "string" ? input : "";
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
  return s || "boggs";
}

export function safeId(input: unknown) {
  const raw = typeof input === "string" ? input : "";
  const s = raw.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80);
  if (s.length < 8) return null;
  return s;
}

export function safeRide(input: unknown) {
  const raw = typeof input === "string" ? input : "";
  return raw
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

export function safeName(input: unknown) {
  const raw = typeof input === "string" ? input : "";
  return raw
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

/** Short glove-friendly chat text. */
export function safeText(input: unknown) {
  const raw = typeof input === "string" ? input : "";
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

export function validLatLng(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    return null;
  }
  return { lat, lng };
}

export function saneTakenAt(value: unknown) {
  const now = Date.now();
  const n = typeof value === "number" ? value : now;
  if (!Number.isFinite(n)) return now;
  if (n > now + 24 * 60 * 60 * 1000) return now;
  if (n < now - 2 * 365 * 24 * 60 * 60 * 1000) return now;
  return n;
}
