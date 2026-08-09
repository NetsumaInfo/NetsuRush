// Mode « remote » : l'app tourne en iframe DANS le panneau CEP Adobe (?remote=1, cf. index.html).
// Flag partagé (App, panneau compact, densité des vues) → UI dégraissée, pensée pour un panneau étroit.
export const IS_REMOTE =
  typeof window !== "undefined" && !!(window as unknown as { __NR_REMOTE__?: boolean }).__NR_REMOTE__;

// Actions que seule la COQUILLE du panneau peut exécuter : recharger l'iframe (l'app ne peut pas
// re-résoudre son URL de base toute seule) et la refermer pour revenir à l'accueil du panneau.
export type PanelAction = "reload" | "home" | "ready";

// La coquille CEP n'a plus de barre à elle (le nom de l'app y doublonnait avec le titre du panneau
// Adobe) : Recharger/Fermer vivent dans l'entête de l'app et repassent ici par postMessage.
export function panelCommand(action: PanelAction): void {
  if (!IS_REMOTE || typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage({ type: "nr:panel", action }, "*");
}

// Accusé de montage : sans lui la coquille ne peut pas distinguer « app chargée » d'un iframe resté
// blanc (build absent, core coupé en plein chargement) et laisserait un panneau vide sans issue.
export function signalPanelReady(): void {
  panelCommand("ready");
}
