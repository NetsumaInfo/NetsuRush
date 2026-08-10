import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { nr } from "@/lib/bridge";
import { useApp, type TabId } from "@/store";
import { Sidebar } from "@/components/Sidebar";
import { DerushSubnav } from "@/components/rushes/DerushSubnav";
import { NotebookTabs } from "@/components/notebook/NotebookTabs";
import { SettingsSubnav } from "@/components/settings/SettingsSubnav";
import { MainContent } from "@/components/MainContent";
import { ViewContextMenu, TitleBarMenu } from "@/components/common/ViewContextMenu";
import { RemotePanel } from "@/components/adobe/RemotePanel";
import { SetupGate } from "@/components/setup/SetupGate";
import { convexConfigured } from "@/lib/convexEnv";
import { useDiscordPresence } from "@/lib/discordPresence";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorBadge } from "@/components/ErrorBadge";
import { PowerPrompt } from "@/components/power/PowerPrompt";
import { WindowControls } from "@/components/WindowControls";
import { IS_REMOTE } from "@/lib/remote";
import { WallpaperLayer } from "@/components/theme/WallpaperLayer";
import { useHostSync } from "@/hooks/useHostSync";
import { useTabSync } from "@/hooks/useTabSync";
import { BrandIcon } from "@/components/BrandIcon";
import { BetaBadge } from "@/components/BetaBadge";
import { UpdateBootstrap } from "@/components/updates/UpdateBootstrap";
import { Spinner } from "@/components/ui/spinner";
import { Toaster } from "@/components/ui/toast";
import { loadExportCapabilities } from "@/features/export/capabilities";
import { GateFrame } from "@/components/auth/GateFrame";

const ReferenceWindow = lazy(() => import("@/components/reference/ReferenceWindow").then((m) => ({ default: m.ReferenceWindow })));
const NotebookWindow = lazy(() => import("@/components/notebook/NotebookWindow").then((m) => ({ default: m.NotebookWindow })));
// Chargé PARESSEUSEMENT : le gate tire convex/react. Sans déploiement Convex il n'est jamais monté,
// et son chunk ne part donc jamais sur le réseau (cf. AuthGate ci-dessous).
const LoginGate = lazy(() => import("@/components/auth/LoginGate").then((m) => ({ default: m.LoginGate })));

// Gate d'accès : traversant tant que Convex n'est pas configuré (dev, navigateur, mock) — même
// contrat qu'avant, mais sans faire entrer la chaîne auth dans le bundle d'entrée.
function AuthGate({ children }: { children: ReactNode }) {
  if (!convexConfigured) return <>{children}</>;
  return <Suspense fallback={<WindowLoading />}><LoginGate>{children}</LoginGate></Suspense>;
}

// Fenêtre détachée du board de référence : même renderer, hash #reference (créée via une 2e
// WebviewWindow Tauri — P3). On rend alors UNIQUEMENT la board nue, sans shell.
const IS_REFERENCE_WINDOW =
  typeof window !== "undefined" && window.location.hash.replace(/^#\/?/, "").startsWith("reference");
// Fenêtre détachée du Carnet : même mécano, hash #notebook — le panneau Carnet nu, sans shell.
const IS_NOTEBOOK_WINDOW =
  typeof window !== "undefined" && window.location.hash.replace(/^#\/?/, "").startsWith("notebook");

// Pages dont l'usage nominal charge durablement des modèles IA ou prépare de nombreux plans.
// Les opérations ponctuelles gardent aussi leurs déclencheurs au moment du job.
const RESOURCE_HEAVY_TABS = new Set<TabId>(["derush", "search", "upscale", "voice"]);

export default function App() {
  // Écoute les retours OAuth deep-link (netsurush://auth) dès le boot — actif avant même le login,
  // puisque c'est ce qui complète la connexion. No-op hors Tauri. Import dynamique : le module tire
  // `better-auth`, inutile de le parser au démarrage quand aucun déploiement Convex n'est configuré.
  useEffect(() => {
    if (!convexConfigured) return;
    void import("@/lib/deepLink").then((m) => m.initAuthDeepLink());
  }, []);
  // Le core sonde et persiste les encodeurs dès son démarrage. Le renderer amorce ici sa lecture
  // unique avant l'ouverture des Paramètres ; tous les éditeurs de profils partagent cette promesse.
  useEffect(() => {
    if (!IS_REFERENCE_WINDOW && !IS_NOTEBOOK_WINDOW && !IS_REMOTE) void loadExportCapabilities();
  }, []);

  return (
    <ErrorBoundary>
      {/* Fond d'écran : couche fixe derrière TOUT le contenu, y compris la fenêtre de référence
          détachée. Se retire d'elle-même dans le panneau Adobe (moteur sans color-mix). */}
      <WallpaperLayer />
      {IS_REFERENCE_WINDOW ? (
        <Suspense fallback={<WindowLoading />}><ReferenceWindow /></Suspense>
      ) : IS_NOTEBOOK_WINDOW ? (
        <Suspense fallback={<WindowLoading />}><NotebookWindow /></Suspense>
      ) : IS_REMOTE ? (
        // Intégré en remote dans le panneau Adobe : coquille dégraissée (sélecteur de vue au lieu du
        // rail latéral, pas de barre de fenêtre) → un max de place. SetupGate sauté (core déjà provisionné).
        <TooltipProvider delay={600}><RemotePanel /></TooltipProvider>
      ) : (
        // Le choix de la langue est la PREMIÈRE étape de l'écran d'installation (SetupGate) et n'a
        // pas d'écran à lui : une question de plus devant celui qui compte est une friction pure.
        // Sans choix explicite (installation déjà provisionnée), l'app suit la locale système —
        // Paramètres › Interface › Langue reste le seul autre point de réglage.
        // Puis gate beta (login Discord) APRÈS le provisionnement.
        <SetupGate><AuthGate><Shell /></AuthGate></SetupGate>
      )}
    </ErrorBoundary>
  );
}

export function WindowLoading() {
  return (
    <GateFrame>
      <div className="grid min-h-48 place-items-center">
        <Spinner className="size-5" />
      </div>
    </GateFrame>
  );
}

function Shell() {
  // Selector ciblé (useShallow) : App ne re-render que sur ces 4 champs — surtout PAS sur le tick
  // de progression d'indexation (indexBusy), sinon toute l'app se fige pendant une tâche.
  const tab = useApp((s) => s.tab);
  // Mode épinglé (coin d'écran) : interface dégraissée — rail latéral et sous-nav masqués pour ne
  // garder que le contenu (vignettes + clic droit). Dépingler via le bouton de la barre de titre.
  const pinned = useApp((s) => s.pinned);
  // Barre latérale masquée entièrement (option clic droit) : on ne réserve plus le rail de 52px.
  const sidebarHidden = useApp((s) => s.sidebarHidden);

  useTabSync();
  useHostSync();

  // Les modules qui chargent durablement des modèles IA proposent la fermeture sûre de Resolve dès
  // leur ouverture. Les actions ponctuelles gardent leurs propres déclencheurs au lancement du job.
  useEffect(() => {
    if (RESOURCE_HEAVY_TABS.has(tab)) useApp.getState().offerCloseForRam();
  }, [tab]);

  // Réapplique l'épinglage (always-on-top) persisté au démarrage : la préférence vit dans le store
  // (localStorage) mais l'état réel de la fenêtre Tauri se perd à chaque lancement.
  useEffect(() => { nr.setAlwaysOnTop(useApp.getState().pinned); }, []);

  // Diagnostic GPU au démarrage : confirme dans la console que le décodage vidéo matériel et
  // WebGPU sont actifs (video_decode/webgpu = "enabled"). navigator.gpu = présence de l'API WebGPU.
  // Optional-chaining : si le core n'expose pas gpuStatus (canal absent), on ne crashe pas — log.
  useEffect(() => {
    nr.gpuStatus?.().then((s) => {
      console.info("[NetsuRush] GPU", s.features ?? s.error, "· navigator.gpu:", "gpu" in navigator);
    }) ?? console.info("[NetsuRush] gpuStatus indisponible (core) · navigator.gpu:", "gpu" in navigator);
  }, []);

  // « Cache projet » : s'abonne à la file d'attente des envois différés (charge + SSE outbox:changed).
  // Le flush auto à la réouverture de l'hôte vit côté core ; ici on garde le miroir renderer à jour.
  useEffect(() => useApp.getState().subscribeOutbox(), []);

  // Fermer/rouvrir le logiciel de montage (libérer RAM/GPU) : charge l'état + SSE power:changed/progress.
  useEffect(() => useApp.getState().subscribePower(), []);

  // Rich Presence Discord : pousse le module ouvert + le projet au core. Monté ICI seulement — les
  // fenêtres détachées (board/carnet) et le panneau Adobe sont le même renderer et pousseraient un
  // contexte concurrent.
  useDiscordPresence();

  // Seuils de stockage (SSE cache:warn) : monté au boot pour que la pastille de la barre latérale
  // s'allume sans avoir à ouvrir les Paramètres. N'efface jamais rien — l'alerte informe seulement.
  useEffect(() => useApp.getState().subscribeCache(), []);

  // Bibliothèque de rushs importés : hydratée AU BOOT, et pas paresseusement au montage de la vue
  // (contrairement aux Collections) — elle alimente `localClips`, que lisent aussi le MediaPicker du
  // board, l'Upscale, les Footages et les pickers d'indexation. Charger tard les afficherait vides
  // tant que l'utilisateur n'a pas ouvert le Derush.
  // La sonde hors-ligne suit APRÈS, séparément : son existsSync peut bloquer plusieurs secondes sur un
  // disque réseau mort, hors de question de retarder l'affichage avec ça.
  useEffect(() => {
    void useApp.getState().loadLibrary().then(() => useApp.getState().checkLibraryOffline());
  }, []);

  // Cache hors-ligne EN FOND (« un vrai système ») : quand Resolve est connecté, ou dès qu'une timeline
  // est créée/supprimée (timelinesEpoch, poussé par le poller resolve:changed), on lance un build
  // INCRÉMENTAL débouncé → il compare l'empreinte complète des timelines et ne réécrit que celles qui
  // ont changé, en cédant la priorité aux lectures live (Media Pool/vignettes). Le cache reste ainsi à jour
  // sans intervention → à la fermeture, tout est déjà là. No-op hors app (nr.snapshot absent).
  const snapConnected = useApp((s) => !!s.status?.connected);
  const timelinesEpoch = useApp((s) => s.timelinesEpoch);
  const snapshotProject = useApp((s) => s.status?.project ?? undefined);
  const snapshotTimeline = useApp((s) => s.status?.timeline ?? undefined);
  const snapshotTimelineRef = useRef(snapshotTimeline);
  useEffect(() => { snapshotTimelineRef.current = snapshotTimeline; }, [snapshotTimeline]);
  const snapshotEpochRef = useRef(timelinesEpoch);
  const snapshotBuildRef = useRef<Promise<unknown> | null>(null);
  const snapshotQueuedRef = useRef<{ project?: string; refreshTimeline?: string } | null>(null);
  const runSnapshotBuild = (opts: { project?: string; refreshTimeline?: string }): void => {
    if (!nr.snapshot) return;
    if (snapshotBuildRef.current) {
      snapshotQueuedRef.current = opts;
      return;
    }
    const run = nr.snapshot.build(opts).catch(() => {});
    snapshotBuildRef.current = run;
    void run.finally(() => {
      if (snapshotBuildRef.current === run) snapshotBuildRef.current = null;
      const queued = snapshotQueuedRef.current;
      snapshotQueuedRef.current = null;
      if (queued && useApp.getState().status?.connected) runSnapshotBuild(queued);
    });
  };
  useEffect(() => {
    if (!snapConnected) {
      snapshotQueuedRef.current = null;
      return;
    }
    const refreshTimeline = snapshotEpochRef.current !== timelinesEpoch ? snapshotTimelineRef.current : undefined;
    snapshotEpochRef.current = timelinesEpoch;
    let cancelled = false;
    let idleId: number | null = null;
    // Laisser l'interface, les timelines et les médias visibles se charger avant le cache offline.
    const timer = window.setTimeout(() => {
      const build = () => {
        if (!cancelled) runSnapshotBuild({ project: snapshotProject, refreshTimeline });
      };
      if (typeof window.requestIdleCallback === "function") idleId = window.requestIdleCallback(build, { timeout: 5000 });
      else build();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (idleId != null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
    };
  }, [snapConnected, timelinesEpoch, snapshotProject]);

  return (
    <TooltipProvider delay={600}>
    <div className="flex h-screen flex-col overflow-hidden">
      {/* barre de titre : zone de drag + marque ; le coin droit reste libre pour les boutons système.
          Clic droit → menu fenêtre (épingler, rail, paramètres…). */}
      <TitleBarMenu>
        <BrandIcon className="size-6" />
        <span className="text-xs font-semibold tracking-tight">NetsuRush</span>
        <BetaBadge />
        {/* sous-nav du derush logée dans la barre de titre (centrée) → zéro bande supplémentaire.
            Centrée par `flex`, JAMAIS par `-translate-x-1/2` : un ancêtre transformé devient le bloc
            conteneur d'un `background-attachment: fixed`, et le fond d'écran repeint dans la barre
            se retrouvait cadré sur le groupe de boutons au lieu de la fenêtre. La bande laisse
            passer les clics pour ne pas manger la zone de déplacement. */}
        {tab === "derush" && !pinned && (
          <div className="pointer-events-none absolute inset-x-0 flex justify-center">
            <div className="pointer-events-auto"><DerushSubnav /></div>
          </div>
        )}
        {/* onglets du Carnet logés dans la barre de titre (façon navigateur) → zéro bande.
            L'espace VIDE de la barre reste une zone de drag ; seuls les onglets sont data-no-drag. */}
        {tab === "notebook" && !pinned && <NotebookTabs />}
        {/* onglets de la page de paramètres courante, même logique : chaque page regroupe plusieurs
            sujets, les onglets n'ont pas à lui coûter une bande de plus. En épinglé la barre est trop
            étroite → la page les rend. */}
        {tab === "settings" && !pinned && (
          <div className="pointer-events-none absolute inset-x-0 flex justify-center">
            <div className="pointer-events-auto"><SettingsSubnav /></div>
          </div>
        )}
        {/* En remote (iframe dans le panneau Adobe) : pas de fenêtre OS à contrôler → pas de min/max/close. */}
        {!IS_REMOTE && <WindowControls />}
      </TitleBarMenu>

      <div className="flex flex-1 overflow-hidden">
        {/* rail réserve 52px ; la Sidebar s'étend en overlay au survol. Masqué en mode épinglé OU si
            l'utilisateur a explicitement caché la barre (clic droit → « Masquer la barre latérale »). */}
        {!pinned && !sidebarHidden && (
          <div className="relative shrink-0" style={{ width: "52px" }}>
            <Sidebar />
          </div>
        )}

        {/* Clic droit sur le fond d'un module → menu custom PERTINENT selon l'onglet (ou couper/copier/
            coller sur un champ). Les cartes/board/éditeurs imbriqués gardent leur propre menu. */}
        <ViewContextMenu>
          <MainContent />
        </ViewContextMenu>
      </div>
      {/* Colonne flottante du coin bas-droit : les pastilles d'état transitoires s'empilent au-dessus
          de l'indicateur d'erreur, qui reste ancré au bas. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        <Toaster />
        <ErrorBadge />
      </div>
      <PowerPrompt />
      <UpdateBootstrap />
    </div>
    </TooltipProvider>
  );
}
