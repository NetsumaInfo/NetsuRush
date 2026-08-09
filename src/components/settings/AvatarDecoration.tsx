// Décoration d'avatar Discord : cadre PNG à centre transparent posé PAR-DESSUS l'avatar. Discord
// l'auteure à ≈1.2× la boîte de l'avatar, centrée. Le parent doit être `relative`.
export function AvatarDecoration({ url, scale = 1.2 }: { url?: string | null; scale?: number }) {
  if (!url) return null;
  const pct = `${scale * 100}%`;
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      referrerPolicy="no-referrer"
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 object-contain"
      style={{ width: pct, height: pct }}
    />
  );
}
