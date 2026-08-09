// Créneaux de PRÉCHAUFFE des proxys d'aperçu : les cartes qui approchent l'écran encodent leur
// proxy en avance, pour que l'aperçu soit prêt AVANT d'arriver dans le viewport.
//
// Borné, et volontairement. Le pré-encode de TOUTE la grille avait été retiré (il noyait NVENC et
// laissait une grille noire) ; ici seule la bande d'anticipation encode, et jamais plus de
// MAX_PREFETCH demandes à la fois. Sans ce plafond, un défilement traversant un rush de 1400 plans
// émettrait autant d'appels /rpc que de cartes traversées : le pont HTTP local n'ouvre que quelques
// sockets, et la file ainsi remplie retarderait AUSSI les vignettes — donc l'inverse du but.
//
// La file est LIFO : la dernière carte inscrite est la plus proche du viewport courant, une
// inscription plus ancienne a de bonnes chances d'être déjà repartie hors bande.

const MAX_PREFETCH = 6;

interface PrefetchJob {
  start: () => void;
  cancelled: boolean;
  started: boolean;
}

let active = 0;
const pending: PrefetchJob[] = [];

function pump(): void {
  while (active < MAX_PREFETCH) {
    const job = pending.pop();
    if (!job) return;
    if (job.cancelled) continue;
    active++;
    job.started = true;
    job.start();
  }
}

// Réserve un créneau de préchauffe. `start` est appelé dès qu'un créneau se libère. La fonction
// rendue libère le créneau : elle doit être appelée à la FIN du travail comme à l'abandon, et elle
// est idempotente (les deux cas se produisent quand une carte quitte la bande pendant son encode).
export function acquirePrefetchSlot(start: () => void): () => void {
  const job: PrefetchJob = { start, cancelled: false, started: false };
  pending.push(job);
  pump();
  return () => {
    if (job.cancelled) return;
    job.cancelled = true;
    if (job.started) {
      active = Math.max(0, active - 1);
      pump();
      return;
    }
    const index = pending.indexOf(job);
    if (index >= 0) pending.splice(index, 1);
  };
}
