import { safeGroup } from "./sanitize";

/** Shared secret typed as the group code. Not shown on the login screen. */
const FALLBACK = "traildesk";

export function adminCode() {
  const fromEnv =
    (typeof process !== "undefined" && (process.env.BOGGS_ADMIN_CODE || process.env.NEXT_PUBLIC_BOGGS_ADMIN_CODE)) || "";
  return safeGroup(fromEnv) || FALLBACK;
}

export function isAdminGroup(group: unknown) {
  return safeGroup(group) === adminCode();
}
