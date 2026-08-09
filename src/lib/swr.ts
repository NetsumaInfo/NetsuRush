// Stale-while-revalidate pour les lectures Resolve : on PEINT d'abord la tranche du snapshot disque
// (nr.snapshot.peek → instantané, zéro appel Resolve), PUIS la lecture live remplace en arrière-plan.
// Toutes les pages qui parcourent Media Pool / timelines partagent ce motif — d'où ce helper unique.
//
// `peek` = promesse du cache (ou undefined en mock) ; `live` = la vraie lecture ; `apply` reçoit les
// DEUX, appelé au plus 2× (cache si présent, puis live). Le live remplace toujours (source de vérité) ;
// un échec live GARDE ce que le cache a peint. `apply(r, cached)` connaît la provenance.
// `peek` est typé `unknown` (les canaux snapshot:peek renvoient `any`) pour NE PAS polluer
// l'inférence de T — T vient uniquement de `live`, la lecture faisant foi. Le cache est casté en T
// (mêmes formes que les replis offline des canaux resolve:*).
export async function swrRead<T>(
  peek: Promise<unknown> | undefined,
  live: () => Promise<T>,
  apply: (r: T, cached: boolean) => void,
): Promise<void> {
  try {
    const p = await peek;
    if (p) apply(p as T, true);
  } catch { /* pas de cache : chargement live classique */ }
  const r = await live();
  apply(r, false);
}
