// Trait de liaison vignette du rail ↔ passage de texte lié. Tracé UNIQUEMENT au survol (l'un ou
// l'autre bout) et en ESCALIER : le passage lié n'est presque jamais en face de sa vignette (il peut
// être des paragraphes plus bas) — un segment horizontal droit pointerait dans le vide. Le chemin
// sort de la vignette, descend/monte au milieu du couloir, puis rejoint le mot (coudes arrondis).
//
// Overlay `position: fixed` en coordonnées écran : le rail vit hors de la feuille et l'éditeur
// défile → un SVG posé dans le flux devrait suivre le scroll. Ici le trait n'existe que pendant le
// survol, donc les coordonnées écran sont exactes et le scroll l'efface (mouseout).

import { useEffect, useState } from "react";

interface Line { d: string; color: string }

const RADIUS = 6;

// Chemin en escalier de (x1,y1) vers (x2,y2) : sortie horizontale, marche verticale au milieu du
// couloir, arrivée horizontale. Coudes arrondis. Retombe sur un trait droit si tout est aligné.
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dy) < 2) return `M${x1} ${y1} H${x2}`;
  const mid = x1 + Math.max(12, dx * 0.4);
  const r = Math.min(RADIUS, Math.abs(dy) / 2, Math.max(0, Math.min(mid - x1, x2 - mid)));
  const s = Math.sign(dy);
  return [
    `M${x1} ${y1}`,
    `H${mid - r}`,
    `Q${mid} ${y1} ${mid} ${y1 + s * r}`,
    `V${y2 - s * r}`,
    `Q${mid} ${y2} ${mid + r} ${y2}`,
    `H${x2}`,
  ].join(" ");
}

function measure(mediaId: string): Line | null {
  const wrap = document.querySelector(`.nb-media-wrap[data-media-id="${CSS.escape(mediaId)}"]`);
  const rail = wrap?.querySelector(".media-card, .media-pill");
  // Premier fragment surligné : un mark peut être coupé en plusieurs spans (split/collage).
  const hl = document.querySelector(`.nr-hl[data-media-id="${CSS.escape(mediaId)}"]`);
  if (!rail || !hl) return null;
  const a = rail.getBoundingClientRect();
  const b = hl.getBoundingClientRect();
  if (!a.width || !b.width) return null;
  const x1 = a.right + 2;
  const y1 = a.top + a.height / 2;
  const x2 = b.left - 3;
  const y2 = b.top + b.height / 2;
  if (x2 - x1 < 8) return null; // texte à gauche de la vignette (cas tordu) → pas de trait
  const color = getComputedStyle(hl).getPropertyValue("--mc").trim() || "var(--primary)";
  return { d: elbow(x1, y1, x2, y2), color };
}

export function LinkConnector() {
  const [line, setLine] = useState<Line | null>(null);

  useEffect(() => {
    // Délégation : les vignettes et les surlignages naissent/meurent au fil de la frappe — aucun
    // listener par élément. Un survol côté rail OU côté texte trace le même trait.
    const idFrom = (t: EventTarget | null): string | null => {
      const el = (t as HTMLElement | null)?.closest?.(".nb-media-wrap[data-media-id], .nr-hl[data-media-id]");
      return el?.getAttribute("data-media-id") || null;
    };
    const over = (e: MouseEvent) => {
      const id = idFrom(e.target);
      setLine(id ? measure(id) : null);
    };
    const out = (e: MouseEvent) => { if (idFrom(e.target)) setLine(null); };
    const clear = () => setLine(null);
    document.addEventListener("mouseover", over);
    document.addEventListener("mouseout", out);
    // Le trait est mesuré en coordonnées écran : tout défilement/redimensionnement l'invalide.
    window.addEventListener("scroll", clear, true);
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mouseout", out);
      window.removeEventListener("scroll", clear, true);
      window.removeEventListener("resize", clear);
    };
  }, []);

  if (!line) return null;
  return (
    <svg className="nb-link-connector" aria-hidden>
      <path d={line.d} stroke={line.color} fill="none" strokeWidth="1.5" strokeDasharray="3 3" />
    </svg>
  );
}
