import { authClient } from "@/lib/authClient";
import { stampAuth } from "@/lib/offlineAuth";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Retour OAuth desktop : le plugin crossDomain (serveur Convex) redirige vers
// `netsurush://auth?ott=<jeton>` (one-time token, 3 min). On l'échange contre une session :
// POST /cross-domain/one-time-token/verify → le fetchPlugin client stocke le cookie de session
// (localStorage "netsurush_cookie") → useConvexAuth passe « authentifié ».
async function completeAuth(url: string): Promise<void> {
  try {
    const ott = new URL(url).searchParams.get("ott");
    if (!ott) {
      console.warn("[auth] deep-link sans ott:", url);
      return;
    }
    const res = (await authClient.$fetch("/cross-domain/one-time-token/verify", {
      method: "POST",
      body: { token: ott },
    })) as { error?: unknown };
    if (res?.error) {
      console.error("[auth] échec de vérification du jeton", res.error);
      return;
    }
    await authClient.getSession(); // hydrate la session (signal useConvexAuth)
    stampAuth();
    console.info("[auth] session établie via deep-link");
  } catch (e) {
    console.error("[auth] complétion deep-link", e);
  }
}

function handleUrls(urls: string[]): void {
  for (const url of urls) {
    if (url.startsWith("netsurush://auth")) void completeAuth(url);
  }
}

let started = false;

// Écoute les liens `netsurush://` : au démarrage à froid (getCurrent) et à chaud (onOpenUrl).
export async function initAuthDeepLink(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  try {
    const dl = await import("@tauri-apps/plugin-deep-link");
    const initial = await dl.getCurrent(); // démarrage à froid (l'URL a lancé l'app)
    if (initial) handleUrls(initial);
    await dl.onOpenUrl(handleUrls); // macOS / cold-start plugin

    // Retour à CHAUD (app déjà ouverte) : Windows relance l'exe, le callback single-instance (lib.rs)
    // ré-émet l'URL ici. C'est LE chemin nominal sur Windows quand l'app tourne déjà.
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string>("nr-deep-link", (e) => {
      if (typeof e.payload === "string") handleUrls([e.payload]);
    });
  } catch (e) {
    console.error("[auth] init deep-link", e);
  }
}
