import { SESSION_MS } from "./park";

export type Session = {
  name: string;
  userId: string;
  group: string;
  vehicle?: string;
  expiresAt: number;
};

const KEY = "boggs.session.v1";

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    if (!session?.name || !session.userId || !session.expiresAt) return null;
    if (session.expiresAt < Date.now()) {
      localStorage.removeItem(KEY);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_MS;
    localStorage.setItem(KEY, JSON.stringify(session));
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Omit<Session, "expiresAt">) {
  const next: Session = { ...session, expiresAt: Date.now() + SESSION_MS };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSession() {
  localStorage.removeItem(KEY);
}
