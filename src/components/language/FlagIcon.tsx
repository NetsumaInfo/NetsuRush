// Drapeaux dessinés en SVG, PAS en emoji : Windows ne fournit aucun glyphe pour les indicateurs
// régionaux → « 🇫🇷 » s'affichait comme les deux lettres « FR ». Six pays, tracés à la main, aucune
// dépendance. Aucun contour : un liseré autour d'un drapeau de 17 px se lit comme un défaut.
import type { LangCode } from "@/i18n";

const VIEW_BOX = "0 0 20 15";

// Étoile à 5 branches centrée sur (0,0), rayon 1 — réutilisée pour les cinq étoiles chinoises.
const STAR = "M0,-1 L0.2245,-0.309 L0.9511,-0.309 L0.3633,0.118 L0.5878,0.809 L0,0.382 L-0.5878,0.809 L-0.3633,0.118 L-0.9511,-0.309 L-0.2245,-0.309 Z";

const SHAPES: Record<LangCode, React.ReactNode> = {
  fr: (
    <>
      <rect width="20" height="15" fill="#f5f5f5" />
      <rect width="6.67" height="15" fill="#002654" />
      <rect x="13.33" width="6.67" height="15" fill="#ce1126" />
    </>
  ),
  // Union Jack simplifié : les diagonales ne sont pas contre-changées (invisible à 16 px).
  en: (
    <>
      <rect width="20" height="15" fill="#012169" />
      <path d="M0,0 L20,15 M20,0 L0,15" stroke="#f5f5f5" strokeWidth="3" />
      <path d="M0,0 L20,15 M20,0 L0,15" stroke="#c8102e" strokeWidth="1.5" />
      <path d="M10,0 L10,15 M0,7.5 L20,7.5" stroke="#f5f5f5" strokeWidth="5" />
      <path d="M10,0 L10,15 M0,7.5 L20,7.5" stroke="#c8102e" strokeWidth="3" />
    </>
  ),
  es: (
    <>
      <rect width="20" height="15" fill="#aa151b" />
      <rect y="3.75" width="20" height="7.5" fill="#f1bf00" />
    </>
  ),
  de: (
    <>
      <rect width="20" height="15" fill="#000000" />
      <rect y="5" width="20" height="5" fill="#dd0000" />
      <rect y="10" width="20" height="5" fill="#ffce00" />
    </>
  ),
  ja: (
    <>
      <rect width="20" height="15" fill="#f5f5f5" />
      <circle cx="10" cy="7.5" r="4.2" fill="#bc002d" />
    </>
  ),
  zh: (
    <>
      <rect width="20" height="15" fill="#ee1c25" />
      <g fill="#ffde00">
        <path d={STAR} transform="translate(4.6 4.4) scale(2.5)" />
        <path d={STAR} transform="translate(9.4 1.9) scale(0.85) rotate(23)" />
        <path d={STAR} transform="translate(11.4 4) scale(0.85) rotate(46)" />
        <path d={STAR} transform="translate(11.4 6.8) scale(0.85) rotate(70)" />
        <path d={STAR} transform="translate(9.4 8.8) scale(0.85) rotate(23)" />
      </g>
    </>
  ),
};

export function FlagIcon({ code, className }: { code: LangCode; className?: string }) {
  return (
    <svg viewBox={VIEW_BOX} className={className ?? "h-[0.8rem] w-[1.05rem] shrink-0"} aria-hidden="true" role="presentation">
      {/* clipPath par code : deux drapeaux dans la même page ne doivent pas partager d'id. */}
      <clipPath id={`flag-${code}`}>
        <rect width="20" height="15" rx="2.2" />
      </clipPath>
      <g clipPath={`url(#flag-${code})`}>{SHAPES[code]}</g>
    </svg>
  );
}
