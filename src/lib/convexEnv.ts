// Témoin de configuration Convex SANS aucune dépendance. Les chemins de boot (main, App) le lisent
// pour décider s'il faut charger la chaîne auth — `convexClient.ts` tire `convex/react` et
// `authClient.ts` tire `better-auth`, soit des centaines de kilo-octets de JS à parser au démarrage
// pour une fonctionnalité qui n'existe pas quand `VITE_CONVEX_URL` est absent (dev, navigateur,
// panneau CEP). Lire l'env ici garde ce coût derrière un import dynamique.
export const convexConfigured = !!(import.meta.env.VITE_CONVEX_URL as string | undefined);

// Site du déploiement (*.convex.site) : routes HTTP, dont le relais des rapports de bug. Distinct de
// `VITE_CONVEX_URL` (*.convex.cloud), qui sert les fonctions.
export const convexSiteUrl = (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined) || "";
