// Plafond des <video> d'aperçu gardées MONTÉES mais EN PAUSE.
//
// Les cartes de plan ne démontent plus leur <video> dès qu'elles cessent de jouer : créer un élément
// média coûte un chargement HTTP plus une init de décodeur, et au défilement la grille en
// détruisait/recréait plusieurs dizaines par seconde (cf. useSceneCardMedia). On garde donc
// l'élément, en pause et masqué derrière la vignette.
//
// Mais Chromium refuse de créer un WebMediaPlayer au-delà d'une limite par frame : passée cette
// borne, des cartes ne jouent plus du tout, sans erreur visible. Seules les <video> EN PAUSE sont
// comptées ici (celles qui jouent sont déjà bornées par le plafond de lecture auto) ; au-delà de
// MAX_PAUSED, la plus ancienne est démontée. FIFO : la plus ancienne est celle qu'on a le moins de
// chances de revoir en remontant le défilement.

// Budget partagé avec la lecture : Chromium refuse de créer un WebMediaPlayer au-delà d'environ 75
// par frame, et `MAX_PLAYING_HARD` (cutStudioShared) en réserve déjà 56. Les deux plafonds doivent
// donc rester sous cette borne ENSEMBLE — sinon les dernières cartes d'un écran dense ne jouent
// jamais, sans la moindre erreur.
// Compte aussi les <video> montées EN AVANCE (bande de préchauffe de useSceneCardMedia) : elles sont
// en pause tant que le créneau de lecture n'est pas accordé, et c'est précisément ce stock d'éléments
// déjà décodés qui fait démarrer une carte à l'instant où elle entre à l'écran.
const MAX_PAUSED = 18;

const retained: (() => void)[] = [];

/** Retient une <video> en pause. Rend la fonction de libération (idempotente). */
export function retainPausedVideo(release: () => void): () => void {
  retained.push(release);
  while (retained.length > MAX_PAUSED) retained.shift()?.();
  return () => {
    const i = retained.indexOf(release);
    if (i >= 0) retained.splice(i, 1);
  };
}

// ---- Rythme de CRÉATION des <video> de préchauffe -------------------------------------------
//
// Le plafond ci-dessus borne la POPULATION ; il ne dit rien du RYTHME. En lecture auto, chaque carte
// entrant dans la bande de préchauffe (±700 px) montait son élément dans la foulée, pendant le rendu.
// Un défilement en fait traverser des dizaines par seconde, et créer un WebMediaPlayer est un travail
// SYNCHRONE du thread principal (chargement + init de décodeur) : d'où le défilement qui avance par
// à-coups, quelques pixels puis un blocage.
//
// Les créations sont donc étalées sur les images. Le nombre de vignettes qui JOUENT ne bouge pas :
// une carte qui doit jouer tout de suite ne passe pas par ici (son créneau de lecture l'a déjà
// rythmée), seules les créations SPÉCULATIVES attendent leur tour. À l'arrêt du défilement, les
// images redeviennent courtes et la file se vide en quelques dizaines de millisecondes.
//
// Le régulateur lit l'ÉCART entre images : il intègre le rendu React et les décodeurs créés au tour
// précédent, seule mesure honnête du coût réel (celui d'un montage ne se voit pas à l'appel, il
// tombe plus tard dans le commit React).
const FRAME_MS = 1000 / 60;
const MOUNT_BURST = 3;

interface MountJob { order: number; grant: () => void }

let mountQueue: MountJob[] = [];
let mountFrame: number | null = null;
let lastMountAt = 0;
let mountDirty = false;

function pumpMounts(): void {
  if (mountFrame != null || typeof requestAnimationFrame !== "function") return;
  mountFrame = requestAnimationFrame(() => {
    mountFrame = null;
    if (!mountQueue.length) return;
    const now = performance.now();
    const frameMs = lastMountAt ? now - lastMountAt : FRAME_MS;
    lastMountAt = now;
    const burst = frameMs > FRAME_MS * 2 ? 1 : frameMs > FRAME_MS * 1.2 ? 2 : MOUNT_BURST;
    // Trié seulement quand la file a bougé : les cartes du HAUT d'abord, comme les créneaux de lecture.
    if (mountDirty) {
      mountQueue.sort((a, b) => a.order - b.order);
      mountDirty = false;
    }
    let granted = 0;
    while (granted < burst) {
      const job = mountQueue.shift();
      if (!job) break;
      granted++;
      job.grant();
    }
    if (granted && mountQueue.length) pumpMounts();
  });
}

/** Demande le droit de monter une <video> de PRÉCHAUFFE. Rend la fonction d'abandon. */
export function requestPreloadMount(order: number, grant: () => void): () => void {
  const job: MountJob = { order, grant };
  mountQueue.push(job);
  mountDirty = true;
  pumpMounts();
  return () => {
    const i = mountQueue.indexOf(job);
    if (i >= 0) mountQueue.splice(i, 1);
  };
}

/** Remet le rythme à zéro (changement de rush) : une file héritée viserait des cartes disparues. */
export function resetPreloadMounts(): void {
  if (mountFrame != null) { cancelAnimationFrame(mountFrame); mountFrame = null; }
  mountQueue = [];
  mountDirty = false;
  lastMountAt = 0;
}
