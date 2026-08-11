// Coordonnées du relais Convex jointes à un rapport de bug. Le core ne peut pas les trouver seul :
// l'URL du site est bakée dans le RENDERER au build (`VITE_CONVEX_SITE_URL`) et la session vit dans
// le localStorage de la webview (plugin crossDomain — pas de cookie hors domaine Convex).
// Import dynamique de `authClient` : statique, il ferait entrer better-auth dans le chunk d'entrée
// de tous les renderers, pour une fonctionnalité absente sans déploiement.

import { convexSiteUrl } from "./convexEnv";

export type BugRelay = { site: string; cookie: string };

export function bugRelayConfigured(): boolean {
  return !!convexSiteUrl;
}

export async function bugRelay(): Promise<BugRelay | null> {
  if (!convexSiteUrl) return null;
  try {
    const { authClient } = await import("./authClient");
    return { site: convexSiteUrl, cookie: authClient.getCookie() || "" };
  } catch {
    // Session illisible : on envoie quand même, le relais accepte les rapports anonymes. La session
    // ne sert qu'à nommer le testeur dans l'embed et à lui donner son propre plafond horaire.
    return { site: convexSiteUrl, cookie: "" };
  }
}
