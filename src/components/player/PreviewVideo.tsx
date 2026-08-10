import { useEffect, useRef, useState } from "react";
import { useApp } from "@/store";
import { IS_REMOTE } from "@/lib/remote";

// Aperçu vidéo hover/lecture-auto PARTAGÉ par les grilles rush (SceneCard) et recherche (ResultCard).
// `play()` est appelé EXPLICITEMENT (pas seulement `autoPlay`) : dans WebView2 un <video autoPlay>
// fraîchement monté ne démarre pas toujours seul → sans ce play() l'aperçu restait figé (bug search).
// La lecture n'est JAMAIS suspendue par le défilement : les aperçus continuent de jouer pendant
// qu'on parcourt la grille. Une pause au flick avait été essayée — elle rendait la grille figée
// pendant le scroll, exactement ce qu'on ne veut pas. La fluidité vient d'ailleurs : DOM léger hors
// écran, aucun backdrop-filter au-dessus d'une vidéo, nombre de lectures plafonné.
export function PreviewVideo({
  url, label, onError, className, audible = false, paused = false,
}: {
  url: string;
  label: string;
  onError: () => void;
  className?: string;
  // Cette carte est-elle SURVOLÉE ? Le son ne joue QUE sur la carte sous la souris : les aperçus en
  // lecture automatique (jusqu'à ~24 simultanés) restent muets → pas de cacophonie. Défaut muet.
  audible?: boolean;
  // La carte ne doit plus jouer (sortie d'écran, créneau rendu) mais on garde l'élément MONTÉ :
  // détruire puis recréer un élément média coûte un chargement + une init de décodeur, et au
  // défilement ça se produisait des dizaines de fois par seconde. Ici on met en pause et on
  // s'efface derrière la vignette. Cf. useSceneCardMedia.
  paused?: boolean;
}) {
  let decodedUrl = url;
  try { decodedUrl = decodeURIComponent(url); } catch { /* malformed proxy URL: inspect raw value */ }
  const animatedWebp = /(?:\.webp)(?:$|[?&])/i.test(decodedUrl);
  const ref = useRef<HTMLVideoElement>(null);
  // Tant que le proxy n'a pas décodé sa 1re frame, un <video> sans poster peint NOIR par-dessus la
  // vignette → flash de rangée noire au scroll (lecture auto qui bascule tout un rang d'un coup).
  // On le garde transparent jusqu'à la 1re frame : la vignette dessous reste visible, zéro flash.
  const [ready, setReady] = useState(false);
  // Nouveau proxy → re-cacher le temps qu'il décode. Reset EN RENDU (pas en effet) : la remise à zéro
  // est synchrone avant la peinture → aucune frame intermédiaire avec l'ancien `ready` (zéro flash).
  const [prevUrl, setPrevUrl] = useState(url);
  if (url !== prevUrl) { setPrevUrl(url); setReady(false); }
  const hoverVolume = useApp((s) => s.hoverVolume);
  const hoverMuted = useApp((s) => s.hoverMuted);
  // Volume des grands lecteurs à 0 = MUET GLOBAL de l'app : il coupe aussi les aperçus au survol.
  // Sans ce lien, couper le son dans le lecteur (le seul curseur de volume visible dans Collections
  // ou le Découpage) laissait les vignettes sonner au passage de la souris.
  const playerVolume = useApp((s) => s.playerVolume);
  // En remote (panneau Adobe, localStorage séparé de l'app → réglages non synchro) : survol TOUJOURS
  // muet, sinon chaque survol relance du son (désagréable) sans possibilité de le couper depuis ici.
  const wantSound = !IS_REMOTE && audible && !hoverMuted && hoverVolume > 0 && playerVolume > 0;
  useEffect(() => {
    if (animatedWebp) return;
    const v = ref.current;
    if (!v) return;
    // `muted` est piloté impérativement (l'attribut JSX reste constant = autoplay toujours autorisé).
    v.volume = hoverVolume;
    v.muted = !wantSound;
    // Rejouer un élément DÉJÀ en lecture relance inutilement le pipeline : on ne touche à l'état de
    // lecture que sur un vrai changement (l'effet re-tourne aussi pour un simple réglage de volume).
    if (paused) { if (!v.paused) v.pause(); return; }
    if (!v.paused) return;
    const p = v.play();
    // Chromium peut bloquer un autoplay AVEC son → repli muet puis relecture (jamais d'aperçu figé).
    if (p && typeof p.catch === "function") p.catch(() => { v.muted = true; v.play().catch(() => {}); });
  }, [paused, wantSound, hoverVolume, animatedWebp]);
  if (animatedWebp) {
    return (
      <img
        // Ne retire jamais la source pendant un défilement : le navigateur relancerait le WebP
        // animé à chaque aller-retour et la carte clignoterait brièvement comme si le média était
        // absent. L'image reste stable ; la vignette en dessous sert uniquement avant onLoad.
        src={url}
        alt={label}
        onError={onError}
        onLoad={() => setReady(true)}
        style={{ opacity: ready && !paused ? 1 : 0 }}
        className={className ?? "absolute inset-0 h-full w-full object-cover"}
      />
    );
  }
  return (
    <video
      ref={ref}
      src={url}
      aria-label={label}
      autoPlay
      loop
      muted
      playsInline
      // `preload="none"` retardait le fetch du proxy jusqu'à l'appel de play() : un aller-retour HTTP
      // de plus AVANT la première image, à chaque carte qui démarre. L'élément n'est monté que
      // lorsqu'on a DÉCIDÉ de lire (cf. showVideo) — il n'y a donc rien à économiser à ne pas charger.
      preload="auto"
      disablePictureInPicture
      onError={onError}
      onLoadedData={() => setReady(true)}
      style={{ opacity: ready && !paused ? 1 : 0 }}
      className={`transition-opacity duration-150 ${className ?? "absolute inset-0 h-full w-full object-cover"}`}
    />
  );
}
