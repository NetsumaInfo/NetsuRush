// Grâce OFFLINE : après un login Discord réussi (en ligne), on tamponne l'instant. Aux lancements
// suivants SANS réseau, l'app reste utilisable tant que ce tampon a moins de 7 jours. Au-delà,
// re-login exigé (donc reconnexion Internet). Honore « gardé, re-login si offline ~1 semaine ».
const KEY = "nr.auth.lastAuthAt";
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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

export function lastAuthAt(): number | null {
  try {
    const v = localStorage.getItem(KEY);
    const n = v ? Number(v) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// true = un login récent (< 7 j) autorise l'usage hors ligne.
export function offlineGraceValid(now: number = Date.now()): boolean {
  const t = lastAuthAt();
  return t !== null && now - t >= 0 && now - t < OFFLINE_GRACE_MS;
}
