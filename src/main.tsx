import React, { type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { BootFrame } from "./components/BootFrame";
import { convexConfigured } from "./lib/convexEnv";
import { initConsoleCapture } from "./lib/appConsole";
import { hydrateUiState } from "./lib/uiState";
import i18n, { initI18n, hasChosenLang, type LangCode } from "./i18n";
import "./index.css";
// CSS tiers du module Carnet (hors pipeline Tailwind, cf. index.css) : éditeur BlockNote + grille rdg.
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "react-data-grid/lib/styles.css";

// Capte les logs (renderer + core + sidecars) au plus tôt pour le panneau Console (debug / bêta-test).
initConsoleCapture();

// Filet de sécurité du glisser-déposer : `dragDropEnabled` est à false côté Tauri, donc un fichier
// lâché arrive en DnD HTML5 — et un drop non traité fait NAVIGUER la WebView vers ce fichier, ce qui
// remplace l'app par la vidéo. On annule donc le comportement par défaut au niveau fenêtre (phase de
// bulle : les zones de dépôt, elles, ont déjà fait leur travail).
// Limité aux FICHIERS : un glisser de texte doit garder son comportement natif (déposer du texte
// dans un champ de saisie).
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => {
    if ((e as DragEvent).dataTransfer?.types.includes("Files")) e.preventDefault();
  });
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// Le bootstrap peut attendre la langue partagée et le provider de connexion. La fenêtre Tauri est
// frameless : on monte donc immédiatement le cadre avec ses contrôles, avant tout travail asynchrone.
root.render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}><BootFrame /></I18nextProvider>
  </React.StrictMode>,
);

// Enveloppe l'app dans le provider Convex+BetterAuth UNIQUEMENT si le déploiement est configuré
// (VITE_CONVEX_URL présent). Sinon (dev/navigateur/mock, panneau CEP, env absent) → App direct.
// L'import est DYNAMIQUE : statique, il faisait entrer convex/react + better-auth dans le chunk
// d'entrée de tous les renderers, à parser au démarrage même sans déploiement.
async function authTree(): Promise<ReactNode> {
  // Import DYNAMIQUE : `App` tire le store, qui lit `localStorage` à l'évaluation de son module.
  // Le charger avant `hydrateUiState()` ferait démarrer l'app sur les valeurs par défaut d'un
  // stockage vidé (profil WebView2 recréé, autre origine) — c'est précisément ce qu'on répare.
  const { default: App } = await import("./App");
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
  // AVANT tout le reste : les réglages de l'interface sont relus depuis le disque et remis dans
  // `localStorage`, seule source de vérité des modules qui suivent (langue comprise).
  await hydrateUiState();
  await initI18n(await sharedLang()).catch(() => {});
  // Provider introuvable (chunk manquant, réseau coupé au 1er lancement) : on rend quand même, pour
  // que l'ErrorBoundary affiche la cause. Rendre l'app SANS gate n'ouvrirait rien — LoginGate lit le
  // même témoin et appelle useConvexAuth, qui échoue faute de provider.
  const tree = await authTree().catch(async (e) => {
    console.error("[auth] provider indisponible", e);
    const { default: App } = await import("./App");
    return <App />;
  });
  root.render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>{tree}</I18nextProvider>
    </React.StrictMode>,
  );
}

void boot();
