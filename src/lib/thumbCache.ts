// Cache mémoire de session des vignettes côté renderer. Une vignette déjà chargée se ressert
// SYNCHRONEMENT au re-montage d'une carte (scroll, recherche, rechargement du Media Pool) : plus
// de round-trip IPC async → plus de squelette qui clignote, plus de vignette qui « disparaît » au
// scroll-retour. Le cache main (RAM + disque) reste la source froide ; celui-ci est la source
// chaude immédiate. Vidé seulement par le bouton « Vider le cache ».
import { nr } from "./bridge";

const cache = new Map<string, string>();

const key = (path: string, time?: number) =>
  time == null ? path : `${path}@${time.toFixed(2)}`;

export function getThumb(path: string, time?: number): string | null {
  return cache.get(key(path, time)) ?? null;
}
export function setThumb(path: string, uri: string, time?: number): void {
  cache.set(key(path, time), uri);
}
export function clearThumbs(): void {
  cache.clear();
}

// Invalidation ciblée après modification d'une timeline : évite de conserver dans le renderer une
// URL vers une ancienne vignette que le core vient de supprimer.
export function forgetThumbs(items: { path: string; time: number }[]): void {
  let removed = false;
  for (const item of items) removed = cache.delete(key(item.path, item.time)) || removed;
  if (removed) subs.forEach((f) => f());
}

// Abonnés réveillés quand le cache reçoit de NOUVELLES vignettes en LOT (primeThumbs). Une carte
// déjà montée (sans vignette) capte l'amorçage et affiche son <img> SANS émettre de RPC : c'est ce
// qui supprime la rafale de ~1 RPC/carte qui saturait les sockets HTTP et figeait le scroll.
const subs = new Set<() => void>();
export function subscribeThumbs(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
// Insère un lot de vignettes (path,time → url) et notifie UNE seule fois (pas par entrée) → les
// cartes abonnées re-lisent le cache en O(cartes), pas O(cartes × entrées).
function primeThumbs(entries: { path: string; uri: string; time?: number }[]): void {
  let added = false;
  for (const e of entries) {
    const k = key(e.path, e.time);
    if (!cache.has(k)) { cache.set(k, e.uri); added = true; }
  }
  if (added) subs.forEach((f) => f());
}

// Résout en UN RPC les chemins des vignettes déjà générées (cache disque/RAM côté core, zéro
// nouveau ffmpeg) et amorce le cache renderer. À appeler à l'ouverture d'une grille (Derush,
// Timeline Live, Collections) → les cartes rendent l'<img> direct, plus de RPC par carte.
export async function warmResolveThumbs(items: { path: string; time: number }[]): Promise<void> {
  if (!items.length) return;
  try {
    const res = await nr.thumbsResolve(items);
    const entries: { path: string; uri: string; time?: number }[] = [];
    for (const r of res || []) if (r && r.file) entries.push({ path: r.path, uri: nr.assetUrl(r.file), time: r.time });
    if (entries.length) primeThumbs(entries);
  } catch { /* best-effort : repli sur le chargement lazy par carte */ }
}

const generation = new Map<string, Promise<void>>();

// Préchauffe les vignettes manquantes par fichier, comme NetsuCut. Les appels sont coalescés afin
// qu'un changement de vue ou un scroll ne relance pas le même lot ffmpeg.
export function warmGenerateThumbs(items: { path: string; time: number }[]): void {
  const groups = new Map<string, { time: number; frame: number }[]>();
  for (const item of items) {
    if (!item.path || !Number.isFinite(item.time)) continue;
    const list = groups.get(item.path) ?? [];
    if (!list.some((x) => Math.abs(x.time - item.time) < 0.005)) list.push({ time: item.time, frame: 0 });
    groups.set(item.path, list);
  }
  for (const [path, list] of groups) {
    const key = `${path}|${list.map((x) => x.time.toFixed(2)).join(",")}`;
    if (generation.has(key)) continue;
    const promise = nr.thumbsBatch(path, list)
      .then(() => warmResolveThumbs(list.map((x) => ({ path, time: x.time }))))
      .catch(() => {})
      .finally(() => { generation.delete(key); });
    generation.set(key, promise);
  }
}
