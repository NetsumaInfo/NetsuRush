export const STALE_HEAD_MS = 30 * 24 * 60 * 60 * 1000;

export function isStaleHead(updatedAt: number, now = Date.now()): boolean {
  return now - updatedAt >= STALE_HEAD_MS;
}
