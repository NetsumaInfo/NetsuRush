// « L'application travaille-t-elle ? » — bus minimal, SANS AUCUN IMPORT (il est lu par coreClient,
// qui est lui-même au fond de la pile : le moindre import créerait un cycle).
//
// Deux sources, complémentaires :
//  1. Le DÉPART d'un appel lourd (`beginHeavyCall`, posé par coreClient) — c'est le signal qui arrive
//     AVANT le travail : la requête n'est même pas partie que l'app se sait occupée. Attendre le
//     premier rapport de progression laisserait tourner l'animation pendant le démarrage du job,
//     c'est-à-dire au moment le plus chargé (chargement de modèle, spawn ffmpeg).
//  2. L'ACTIVITÉ rapportée (`pingHeavyActivity`, posé sur les canaux de progression) — indispensable
//     parce qu'un appel peut rendre la main tout de suite alors que le travail continue côté daemon,
//     et parce qu'un job lancé depuis une autre fenêtre ne passe par aucun appel d'ici.

/** Silence au-delà duquel un travail sans appel en vol est considéré fini. */
const IDLE_MS = 2500;

/**
 * Canaux dont l'appel signifie « la machine va chauffer ». Liste EXPLICITE plutôt qu'un préfixe :
 * `roto:setView` ou `search:status` partagent le préfixe de vrais jobs sans rien coûter, et geler le
 * fond au moindre clic serait un défaut visible.
 */
const HEAVY_CHANNELS = new Set([
  // Traitements NetsuLab (upscale, interpolation, profondeur, détourage) et leurs essais 1 image.
  "upscale:run", "upscale:shaderRun", "upscale:testFrame",
  "process:depth", "process:interpolate", "process:removeBg", "process:testFrame",
  "pipeline:run",
  // Roto : ouverture (extraction des frames), suivi, matte fin, suppression d'objet, export.
  "roto:open", "roto:propagate", "roto:refine", "roto:objectRemove", "roto:export",
  // Encodage et rendu.
  "export:clips", "ffmpeg:export", "ae:export", "transfer:run", "netsu:export", "netsu:import",
  // Détection de plans et découpe de timeline.
  "ffmpeg:detectScenes", "resolve:analyzeTimelineCut", "resolve:buildCutTimeline", "resolve:cutTimeline",
  // Voix (ASR + VAD) et dictée.
  "voice:transcribe", "voice:detectSilences", "voice:exportCut", "dictate:transcribe",
  // Recherche : indexation et regroupements (les requêtes servies par l'index restent légères).
  "search:index", "search:run", "search:cluster", "search:dedup",
  "face:detect", "face:index", "char:labelIndex",
  // Téléchargements de modèles (disque + réseau saturés).
  "models:download", "models:import",
  // Board : upscale d'un item, décomposition en frames.
  "reference:upscaleItem", "reference:extractFrames",
  // Le fond lui-même : son import encode, il n'a aucune raison de s'exempter. `wallpaper:variant`
  // en est EXCLU volontairement — la couche demande une variante PARCE QUE l'état d'occupation a
  // changé ; l'y inclure ferait osciller le fond entre figé et animé toutes les 2,5 s.
  "wallpaper:import",
]);

export function isHeavyChannel(channel: string): boolean {
  return HEAVY_CHANNELS.has(channel);
}

type Listener = (busy: boolean) => void;

const listeners = new Set<Listener>();
let inFlight = 0;
let lastActivity = 0;
let busy = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function publish(next: boolean): void {
  if (next === busy) return;
  busy = next;
  for (const listener of listeners) listener(busy);
}

function scheduleIdleCheck(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Un appel toujours en vol (un suivi Roto dure des minutes) garde l'état occupé.
    if (inFlight > 0) return scheduleIdleCheck();
    if (Date.now() - lastActivity < IDLE_MS) return scheduleIdleCheck();
    publish(false);
  }, IDLE_MS);
}

/** Marque un travail lourd en vol. Le retour DOIT être appelé (finally) sinon l'état reste occupé. */
export function beginHeavyCall(): () => void {
  inFlight++;
  lastActivity = Date.now();
  publish(true);
  let released = false;
  return () => {
    if (released) return; // double libération : ne pas décompter deux fois le même appel
    released = true;
    inFlight = Math.max(0, inFlight - 1);
    lastActivity = Date.now();
    scheduleIdleCheck();
  };
}

/** Un travail a rapporté sa progression : l'état reste occupé encore {@link IDLE_MS}. */
export function pingHeavyActivity(): void {
  lastActivity = Date.now();
  publish(true);
  scheduleIdleCheck();
}

export function subscribeBusy(listener: Listener): () => void {
  listeners.add(listener);
  listener(busy);
  return () => { listeners.delete(listener); };
}
