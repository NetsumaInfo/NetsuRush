import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App, { WindowLoading } from "./App";
import { convexConfigured } from "./lib/convexEnv";
import { initConsoleCapture } from "./lib/appConsole";
import i18n, { initI18n, hasChosenLang, type LangCode } from "./i18n";
import "./index.css";
// CSS tiers du module Carnet (hors pipeline Tailwind, cf. index.css) : éditeur BlockNote + grille rdg.
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "react-data-grid/lib/styles.css";

// Capte les logs (renderer + core + sidecars) au plus tôt pour le panneau Console (debug / bêta-test).
initConsoleCapture();

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Le bootstrap peut attendre la langue partagée et le provider de connexion. La fenêtre Tauri est
// frameless : on monte donc immédiatement le cadre avec ses contrôles, avant tout travail asynchrone.
root.render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}><WindowLoading /></I18nextProvider>
  </React.StrictMode>,
);

// Enveloppe l'app dans le provider Convex+BetterAuth UNIQUEMENT si le déploiement est configuré
// (VITE_CONVEX_URL présent). Sinon (dev/navigateur/mock, panneau CEP, env absent) → App direct.
// L'import est DYNAMIQUE : statique, il faisait entrer convex/react + better-auth dans le chunk
// d'entrée de tous les renderers, à parser au démarrage même sans déploiement.
async function authTree(): Promise<ReactNode> {
  if (!convexConfigured) return <App />;
  const [{ ConvexBetterAuthProvider }, { convexClient }, { authClient }] = await Promise.all([
    import("@convex-dev/better-auth/react"),
    import("./lib/convexClient"),
    import("./lib/authClient"),
  ]);
  if (!convexClient) return <App />;
  return (
    <ConvexBetterAuthProvider client={convexClient} authClient={authClient}>
      <App />
    </ConvexBetterAuthProvider>
  );
}

// Résout la langue de départ ET charge ses ressources AVANT le premier rendu (pas de flash de repli
// fr pour un utilisateur en ja/zh au démarrage à froid). i18n est déjà initialisé en fr en repli.
// I18nextProvider coiffe TOUJOURS : placé ici (au-dessus de App), il couvre les 3 renderers
// (Shell, fenêtre Référence, panneau Adobe remote) qui contournent tous les gates plus bas.
// Préférence de langue APP-WIDE, tenue par le core dans `nr.config.json`. Seul recours d'un
// renderer sans choix local : le panneau CEP charge l'app depuis 127.0.0.1:8730, donc une autre
// origine que l'app Tauri — son localStorage est vierge et la langue choisie était ignorée.
async function sharedLang(): Promise<LangCode | undefined> {
  if (hasChosenLang()) return undefined; // choix local explicite : il gagne
  try {
    const { nr } = await import("./lib/bridge");
    const code = (await nr.configGet?.())?.lang;
    return (code as LangCode | undefined) || undefined;
  } catch {
    return undefined; // core injoignable → langue du système, comme avant
  }
}

async function boot(): Promise<void> {
  await initI18n(await sharedLang()).catch(() => {});
  // Provider introuvable (chunk manquant, réseau coupé au 1er lancement) : on rend quand même, pour
  // que l'ErrorBoundary affiche la cause. Rendre l'app SANS gate n'ouvrirait rien — LoginGate lit le
  // même témoin et appelle useConvexAuth, qui échoue faute de provider.
  const tree = await authTree().catch((e) => {
    console.error("[auth] provider indisponible", e);
    return <App />;
  });
  root.render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>{tree}</I18nextProvider>
    </React.StrictMode>,
  );
}

void boot();
