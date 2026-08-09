import { useCallback, useState } from "react";
import { authClient } from "@/lib/authClient";
import i18n from "@/i18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Retour OAuth : on vise la page HTTPS `/auth/done` du site Convex (pas le scheme direct) → le
// navigateur affiche une vraie page qui relance l'app via `netsurush://auth?ott=…` puis invite à
// fermer l'onglet (fini le « charge à l'infini »). Repli scheme direct si le site n'est pas défini.
const SITE = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
export const AUTH_CALLBACK = SITE ? `${SITE}/auth/done` : "netsurush://auth";

/**
 * Lance le login Discord : ouvre le NAVIGATEUR SYSTÈME sur l'URL d'autorisation (jamais dans la
 * webview → on ne quitte pas l'app). La session se complète au retour deep-link, en réactif.
 */
export function useDiscordLogin() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setError(null);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError(i18n.t("auth:login.offlineNeedsNet"));
      return;
    }
    setBusy(true);
    let handedOff = false;
    try {
      // disableRedirect : renvoie l'URL au lieu de naviguer la webview.
      const res = await authClient.signIn.social({
        provider: "discord",
        callbackURL: AUTH_CALLBACK,
        disableRedirect: true,
      });
      const url = (res as { data?: { url?: string } }).data?.url;
      if (!url) throw new Error(i18n.t("auth:login.authUrlMissing"));
      if (isTauri) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
      } else {
        window.open(url, "_blank", "noopener");
      }
      // busy reste vrai : « en attente de Discord… » jusqu'au retour deep-link (le gate rend le Shell).
      handedOff = true;
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      if (!handedOff) setBusy(false);
    }
  }, []);

  // Réinitialise l'attente (bouton « réessayer » si l'utilisateur revient sans avoir validé).
  const reset = useCallback(() => {
    setBusy(false);
    setError(null);
  }, []);

  return { login, busy, error, reset };
}
