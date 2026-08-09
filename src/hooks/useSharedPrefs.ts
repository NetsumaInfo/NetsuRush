import { useEffect, useRef } from "react";
import { nr } from "@/lib/bridge";
import { IS_REMOTE } from "@/lib/remote";
import { useApp } from "@/store";
import type { AppState } from "@/store";
import type { ExportProfile } from "@/features/export/profiles";
import type { DetectModel, DetectOptions } from "@/lib/bridge";
import { DEFAULT_TIMELINE_INSERTIONS, type TimelineHost, type TimelineInsertionMode } from "@/features/timeline/insertion";
import type { SearchPerfSettings } from "@/lib/searchPerf";
import type { SamplingFrames } from "@/lib/sampling";

// Écriture groupée : une frappe dans un champ de profil ne doit pas écrire un fichier par caractère.
const PUSH_DEBOUNCE_MS = 400;

// Réglages du renderer PARTAGÉS entre origines. `localStorage` est par ORIGINE : l'app Tauri
// (tauri://localhost), le panneau CEP (http://…/app) et les fenêtres détachées avaient chacun leur
// copie. Conséquence concrète et signalée : un rush découpé dans l'app ressortait « pas découpé »
// dans le panneau — le cache de plans est indexé sur (fichier, modèle, seuil, options), et le
// panneau restait sur les valeurs par défaut. On garde donc la vérité côté core (core/prefs.js).
//
// Ne sont partagés que les réglages qui décrivent le TRAVAIL (détection, export, insertion), jamais
// ceux qui décrivent la FENÊTRE (hôte actif, largeur du lecteur, épinglage) : chaque surface garde
// les siens.
interface SharedPrefs {
  cutModel: DetectModel;
  cutPreset: number;
  detectionOptions: DetectOptions;
  exportProfiles: ExportProfile[];
  activeExportProfileId: string;
  cardActionProfileId: string;
  timelineInsertions: Record<TimelineHost, TimelineInsertionMode>;
  // Le core les relit à chaque spawn de sidecar (core/prefs.js#perfEnv) : c'est le seul réglage
  // partagé que le BACKEND consomme, pas seulement les autres fenêtres.
  searchPerf: SearchPerfSettings;
  // Change les vecteurs produits : deux fenêtres qui n'échantillonnent pas pareil se renverraient
  // l'index l'une à l'autre comme « à refaire ».
  searchFrames: SamplingFrames;
}

function snapshot(state: AppState): SharedPrefs {
  return {
    cutModel: state.cutModel,
    cutPreset: state.cutPreset,
    detectionOptions: state.detectionOptions,
    exportProfiles: state.exportProfiles,
    activeExportProfileId: state.activeExportProfileId,
    cardActionProfileId: state.cardActionProfileId,
    timelineInsertions: state.timelineInsertions,
    searchPerf: state.searchPerf,
    searchFrames: state.searchFrames,
  };
}

/** Applique un patch venu du core par les SETTERS du store (qui réécrivent aussi le localStorage local). */
function applyShared(patch: Partial<SharedPrefs>): void {
  const state = useApp.getState();
  if (patch.cutModel) state.setCutModel(patch.cutModel);
  if (typeof patch.cutPreset === "number") state.setCutPreset(patch.cutPreset);
  if (patch.detectionOptions) state.setDetectionOptions(patch.detectionOptions);
  // Profils + sélections en UN appel : poser l'id actif avant la liste le ferait rejeter.
  if (patch.exportProfiles?.length) {
    state.replaceExportProfiles(patch.exportProfiles, patch.activeExportProfileId, patch.cardActionProfileId);
  }
  if (patch.searchPerf) state.setSearchPerf(patch.searchPerf);
  if (patch.searchFrames) state.setSearchFrames(patch.searchFrames);
  if (patch.timelineInsertions) {
    for (const host of Object.keys(DEFAULT_TIMELINE_INSERTIONS) as TimelineHost[]) {
      const mode = patch.timelineInsertions[host];
      if (mode) state.setTimelineInsertion(host, mode);
    }
  }
}

export function useSharedPrefs(): void {
  // Vrai pendant l'application d'un état distant : sans ce garde, chaque hydratation repartirait
  // aussitôt en écriture (et deux renderers ouverts se renverraient la balle indéfiniment).
  const applying = useRef(false);
  const lastPushed = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const push = (next: SharedPrefs) => {
      const json = JSON.stringify(next);
      if (json === lastPushed.current) return;
      lastPushed.current = json;
      void nr.prefsSet(next as unknown as Record<string, unknown>).catch(() => { lastPushed.current = null; });
    };

    const receive = (patch: Partial<SharedPrefs>) => {
      applying.current = true;
      try {
        applyShared(patch);
      } finally {
        // Le store a fini de muter : la valeur reçue devient la référence, sinon l'abonnement
        // ci-dessous la renverrait au core comme si l'utilisateur venait de la changer.
        lastPushed.current = JSON.stringify(snapshot(useApp.getState()));
        applying.current = false;
      }
    };

    void nr.prefsGet().then((r) => {
      if (!alive) return;
      const stored = (r?.prefs ?? {}) as Partial<SharedPrefs>;
      // Premier lancement (fichier vide) : seule l'APP sème les valeurs. Si le panneau CEP semait,
      // ses défauts (il n'a jamais rien réglé) deviendraient la référence et écraseraient les
      // réglages de l'app à son prochain démarrage.
      if (Object.keys(stored).length) receive(stored);
      else if (!IS_REMOTE) push(snapshot(useApp.getState()));
    }).catch(() => { /* core injoignable : réglages locaux, comme avant */ });

    const offRemote = nr.onPrefsChanged((p) => { if (alive && p?.patch) receive(p.patch as Partial<SharedPrefs>); });

    const offStore = useApp.subscribe((state) => {
      if (applying.current) return;
      const next = snapshot(state);
      if (JSON.stringify(next) === lastPushed.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; push(snapshot(useApp.getState())); }, PUSH_DEBOUNCE_MS);
    });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      offRemote();
      offStore();
    };
  }, []);
}
