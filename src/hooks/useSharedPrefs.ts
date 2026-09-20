import { useEffect, useRef } from "react";
import { nr } from "@/lib/bridge";
import { IS_REMOTE } from "@/lib/remote";
import { useApp } from "@/store";
import type { AppState } from "@/store";
import type { ExportProfile } from "@/features/export/profiles";
import type { DetectModel, DetectOptions, PreviewGenerationSettings } from "@/lib/bridge";
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
  // Part of the proxy and thumbnail cache keys: a panel left on the defaults re-encoded every
  // preview the app had already produced under the user's settings.
  previewSettings: PreviewGenerationSettings;
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
    previewSettings: state.previewSettings,
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
  // Every push carries the whole snapshot, and this setter resets every grid's thumbnails and
  // proxies: apply it only when the value actually differs.
  if (patch.previewSettings && JSON.stringify(patch.previewSettings) !== JSON.stringify(state.previewSettings)) {
    state.setPreviewSettings(patch.previewSettings);
  }
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
  // Tant que l'état du core n'est pas revenu, une mutation du store (un module qui écrit son défaut
  // au montage) écrirait ces DÉFAUTS sur le disque et effacerait les réglages de l'utilisateur.
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Keys the core is known to hold. The panel writes only those: every push carries the whole
    // snapshot, and a key the app has not seeded yet would otherwise leave with the panel's defaults.
    const known = new Set<string>();
    // The core echoes every push back to its sender. Applying that echo after the user has moved on
    // would revert the newer value, and cancel its pending push. Single use: kept any longer, it
    // would swallow another renderer's legitimate return to the same values.
    let lastSent: string | null = null;

    const push = (next: SharedPrefs) => {
      const json = JSON.stringify(next);
      if (json === lastPushed.current) return;
      lastPushed.current = json;
      const payload = IS_REMOTE
        ? Object.fromEntries(Object.entries(next).filter(([key]) => known.has(key)))
        : next;
      if (!Object.keys(payload).length) return;
      lastSent = JSON.stringify(payload);
      void nr.prefsSet(payload as unknown as Record<string, unknown>).catch(() => {
        lastPushed.current = null;
        lastSent = null;
      });
    };

    const receive = (patch: Partial<SharedPrefs>) => {
      for (const key of Object.keys(patch)) known.add(key);
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
      // Idem pour un fichier ANTÉRIEUR à une clé partagée : c'est l'app qui sème la clé manquante.
      if (Object.keys(stored).length) receive(stored);
      const local = snapshot(useApp.getState());
      if (!IS_REMOTE && Object.keys(local).some((key) => !(key in stored))) {
        lastPushed.current = null;
        push(local);
      }
      hydrated.current = true;
    }).catch(() => { hydrated.current = true; /* core injoignable : réglages locaux, comme avant */ });

    const offRemote = nr.onPrefsChanged((p) => {
      if (!alive || !p?.patch) return;
      const echo = JSON.stringify(p.patch) === lastSent;
      lastSent = null;
      if (!echo) receive(p.patch as Partial<SharedPrefs>);
    });

    const offStore = useApp.subscribe((state) => {
      if (applying.current || !hydrated.current) return;
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
