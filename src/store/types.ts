// Types partagés du store (onglets, vue derush).
export type TabId = "derush" | "search" | "reference" | "notebook" | "script" | "upscale" | "voice" | "chat" | "flow" | "optimisation" | "transfer" | "adobe" | "settings";
// Hôte cible actif : NLE piloté par NetsuRush. Sélecteur en pied de sidebar. Resolve = flux natif
// (pont Python) ; ppro/aeft = via le panneau CEP. Persisté (localStorage nr.activeHost).
export type HostId = "resolve" | "ppro" | "aeft";
export type DerushView = "home" | "browser";
// Sous-onglet de l'onglet Derush : découpage (flux existant), collections (bibliothèque), timeline live.
export type DerushSection = "decoupage" | "collections" | "timeline";

// Thèmes commutables (cf. blocs [data-theme] dans src/index.css). Les libellés/descriptions ici sont
// le repli hors i18n : l'UI lit d'abord `settings:appearance.theme.<id>`.
export type ThemeId =
  | "dark" | "midnight" | "blue" | "graphite" | "forest" | "ember" | "plum" | "contrast"
  | "light" | "soft-light" | "paper";
export type ThemeMode = "dark" | "light";
export const THEMES: { id: ThemeId; mode: ThemeMode; label: string }[] = [
  { id: "dark", mode: "dark", label: "Sombre" },
  { id: "midnight", mode: "dark", label: "Minuit" },
  { id: "blue", mode: "dark", label: "Bleu nuit" },
  { id: "graphite", mode: "dark", label: "Graphite" },
  { id: "forest", mode: "dark", label: "Forêt" },
  { id: "ember", mode: "dark", label: "Braise" },
  { id: "plum", mode: "dark", label: "Prune" },
  { id: "contrast", mode: "dark", label: "Contraste élevé" },
  { id: "light", mode: "light", label: "Clair" },
  { id: "soft-light", mode: "light", label: "Clair doux" },
  { id: "paper", mode: "light", label: "Papier" },
];

export { basename } from "@/lib/utils";
