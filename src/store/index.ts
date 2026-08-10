// Store applicatif (zustand) composé de slices : coquille (onglet/sidebar/statut), derush
// (clips + envoi timeline) et recherche (SigLIP 2). Chaque slice est typée sur l'état complet,
// si bien qu'une action peut lire/écrire les champs d'une autre slice (ex. sendHitsToTimeline
// réutilise le toast tlBusy/tlNotice de derush).
import { create } from "zustand";
import { createShellSlice, type ShellSlice } from "./shell";
import { createDerushSlice, type DerushSlice } from "./derush";
import { createCollectionsSlice, type CollectionsSlice } from "./collections";
import { createLibrarySlice, type LibrarySlice } from "./library";
import { createSearchSlice, type SearchSlice } from "./search";
import { createCharacterSlice, type CharacterSlice } from "./characters";
import { createSettingsSlice, type SettingsSlice } from "./settings";
import { createChatSlice, type ChatSlice } from "./chat";
import { createOptimizeSlice, type OptimizeSlice } from "./optimize";
import { createVoiceSlice, type VoiceSlice } from "./voice";
import { createProcessSlice, type ProcessSlice } from "./process";
import { createNetsulabSlice, type NetsulabSlice } from "./netsulab";
import { createExportSlice, type ExportSlice } from "./export";
import { createAdobeSlice, type AdobeSlice } from "./adobe";
import { createNotebookSlice, type NotebookSlice } from "./notebook";
import { createOutboxSlice, type OutboxSlice } from "./outbox";
import { createPowerSlice, type PowerSlice } from "./power";
import { createStorageSlice, type StorageSlice } from "./storage";

export type { TabId, DerushSection } from "./types";

export type AppState = ShellSlice & DerushSlice & CollectionsSlice & LibrarySlice & SearchSlice & CharacterSlice & SettingsSlice & ChatSlice & OptimizeSlice & VoiceSlice & ProcessSlice & NetsulabSlice & ExportSlice & AdobeSlice & NotebookSlice & OutboxSlice & PowerSlice & StorageSlice;

export const useApp = create<AppState>()((...a) => ({
  ...createShellSlice(...a),
  ...createDerushSlice(...a),
  ...createCollectionsSlice(...a),
  ...createLibrarySlice(...a),
  ...createSearchSlice(...a),
  ...createCharacterSlice(...a),
  ...createSettingsSlice(...a),
  ...createChatSlice(...a),
  ...createOptimizeSlice(...a),
  ...createVoiceSlice(...a),
  ...createProcessSlice(...a),
  ...createNetsulabSlice(...a),
  ...createExportSlice(...a),
  ...createAdobeSlice(...a),
  ...createNotebookSlice(...a),
  ...createOutboxSlice(...a),
  ...createPowerSlice(...a),
  ...createStorageSlice(...a),
}));

// Dev uniquement : expose le store pour piloter/inspecter l'UI depuis un outil de preview
// (force-render d'une vue qui dépend d'un état Resolve absent en navigateur). Strip en prod.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __useApp?: typeof useApp }).__useApp = useApp;
}
