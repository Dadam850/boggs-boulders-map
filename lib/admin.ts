import { safeGroup } from "./sanitize";

/** Shared secret typed as the group code. Not shown on the login screen. */
const FALLBACK = "traildesk";

export function adminCode() {
  const fromEnv = (
    (typeof process !== "undefined" && (process.env.BOGGS_ADMIN_CODE || process.env.NEXT_PUBLIC_BOGGS_ADMIN_CODE)) ||
    ""
  ).trim();
  // safeGroup("") becomes "boggs" — never treat an empty env as the desk code.
  if (!fromEnv) return FALLBACK;
  return safeGroup(fromEnv) || FALLBACK;
}

export function isAdminGroup(group: unknown) {
  if (typeof group !== "string" || !group.trim()) return false;
  return safeGroup(group) === adminCode();
}
