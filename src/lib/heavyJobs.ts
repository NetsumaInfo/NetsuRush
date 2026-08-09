// Branche les canaux de progression du core sur le bus d'occupation (`busyBus`). Le DÉPART des
// travaux est déjà capté par coreClient ; ces abonnements couvrent la suite : un appel qui rend la
// main pendant que le daemon continue, et les jobs lancés depuis une autre fenêtre.
import { nr } from "@/lib/bridge";
import { pingHeavyActivity, subscribeBusy } from "@/lib/busyBus";

type Unsubscribe = () => void;

/** Canaux à surveiller : tout ce qui fait chauffer GPU, CPU ou disque. */
function subscribeProgress(): Unsubscribe[] {
  const hit = () => pingHeavyActivity();
  return [
    nr.onScenesProgress(hit),
    nr.onUpscaleProgress(hit),
    nr.onProcessProgress(hit),
    nr.onRotoProgress(hit),
    nr.onExportProgress(hit),
    nr.onAeProgress(hit),
    nr.onTransferProgress(hit),
    nr.onVoiceProgress(hit),
    nr.onSearchProgress(hit),
    nr.onModelsProgress(hit),
    nr.onPipelineProgress(hit),
    nr.onTimelineCutProgress(hit),
    nr.onBoostProgress(hit),
  ];
}

/**
 * Appelle `onChange(true)` dès qu'un travail lourd DÉMARRE (avant même que la requête parte) et
 * `onChange(false)` une fois le dernier appel rendu et la progression silencieuse. Renvoie de quoi
 * se désabonner.
 */
export function subscribeHeavyJobs(onChange: (busy: boolean) => void): Unsubscribe {
  const stops = subscribeProgress();
  const stopBus = subscribeBusy(onChange);
  return () => {
    stopBus();
    for (const stop of stops) stop();
  };
}
