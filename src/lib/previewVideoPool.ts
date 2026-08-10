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

const MAX_PAUSED = 16;

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
