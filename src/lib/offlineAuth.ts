// OFFLINE grace: after a successful (online) login the instant is stamped. On later launches with NO
// network the app stays usable as long as that stamp is under 30 days old. Past that, a new login is
// required — which means going back online.
const KEY = "nr.auth.lastAuthAt";
const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export function stampAuth(now: number = Date.now()): void {
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    /* localStorage indispo : la grâce offline sera simplement inactive */
  }
}

export function clearAuthStamp(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

function lastAuthAt(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// true = un login récent (< 30 j) autorise l'usage hors ligne.
export function offlineGraceValid(now: number = Date.now()): boolean {
  const t = lastAuthAt();
  return t !== null && now - t >= 0 && now - t < OFFLINE_GRACE_MS;
}
