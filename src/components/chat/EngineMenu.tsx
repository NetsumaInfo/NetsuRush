// Les réglages du moteur, dans le composer : QUI tourne, avec quel modèle,
// sous quelles permissions.
//
// TROIS menus, pas un. Ils tenaient dans un seul, et cela produisait une
// colonne qui couvrait la moitié de la fenêtre : agents, clés, liste de
// modèles, champ libre, paliers de réflexion et permissions empilés sous un
// même bouton. Ce sont trois décisions séparées, prises à des moments
// différents — on change de modèle souvent, de permissions presque jamais.
//
// Le choix du moteur est UN choix. Il en demandait deux : « CLI » puis, une
// fois ce moteur retenu, « lequel » — parce que le protocole envoie
// `provider:"cli"` plus un identifiant d'agent, et que cette forme de fil avait
// débordé dans le menu. On y lit maintenant « Claude Code », « Codex »,
// « Anthropic » sur le même plan (cf. buildEngines).
//
// Les modèles ne sont plus écrits ici : ils viennent du core, qui les demande
// au fournisseur. La liste tapée à la main avait pris une génération de retard.
import { useEffect, useMemo, useState } from "react";
import {
  Bot, Sparkles, Globe, Terminal, ChevronDown, ChevronLeft, Eye, Hand, ShieldAlert, Zap,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "@/store";
import { buildEngines, toEngineId, type Engine } from "@/lib/agentCatalog";
import type { ChatPermMode } from "@/lib/bridge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ThinkingSlider } from "./ThinkingSlider";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";

// Trois modes, du plus gardé au plus libre, chacun avec l'icône qui le dit d'un
// coup d'œil. Il y en avait quatre ; le quatrième dupliquait la timeline avant
// d'écrire, ce qui est un souhait distinct de « combien l'agent demande » — il
// est devenu la case du bas.
const MODES: { id: ChatPermMode; icon: typeof Eye; tone?: string }[] = [
  { id: "read-only", icon: Eye },
  { id: "ask", icon: Hand },
  { id: "auto", icon: ShieldAlert, tone: "text-destructive" },
];

// Modèle abrégé (claude-opus-5 → opus-5 ; anthropic/claude-opus-5 → claude-opus-5).
const shortModel = (m: string, fallback: string) => {
  const last = m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
  return last.replace(/^claude-/, "") || fallback;
};

function EngineIcon({ engine, className }: { engine: Engine | undefined; className?: string }) {
  if (!engine) return <Bot className={className} />;
  if (engine.kind === "cli") return <Terminal className={className} />;
  if (engine.id === "api:openai") return <Sparkles className={className} />;
  if (engine.id === "api:openrouter") return <Globe className={className} />;
  if (engine.id === "api:xai") return <Zap className={className} />;
  return <Bot className={className} />;
}

/// Déclencheur commun aux trois socles, pour qu'ils se ressemblent : même
/// hauteur, même densité, même chevron.
///
/// Il est passé à `render` : Base UI lui remet TOUTES les props du déclencheur —
/// l'ouverture au clic, l'état `aria-expanded`, la ref qui sert à positionner le
/// menu. N'en garder que `children` rendait un bouton qui s'enfonce (état natif)
/// mais n'ouvre jamais rien, les trois menus muets d'un coup. On les reconduit
/// donc en bloc, et la classe du socle FUSIONNE avec celle qu'on lui donne au
/// lieu de l'écraser.
function Socle({ className, children, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="sm"
      {...props}
      className={cn("h-7 min-w-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground", className)}
    >
      {children}
      <ChevronDown className="size-3 shrink-0 opacity-60" />
    </Button>
  );
}

/// Une ligne de moteur. Un moteur non prêt reste VISIBLE mais désactivé : le
/// cacher ferait croire qu'il n'existe pas, alors qu'il ne manque qu'une clé.
function EngineRow({ engine, notReady }: { engine: Engine; notReady: string }) {
  return (
    <DropdownMenuRadioItem value={engine.id} disabled={!engine.ready} className="items-center gap-2 py-1.5">
      <EngineIcon engine={engine} className="size-4 shrink-0" />
      <span className="truncate text-xs font-medium">{engine.label}</span>
      {engine.hint ? <code className="text-[10px] text-muted-foreground">{engine.hint}</code> : null}
      {!engine.ready ? <span className="ml-auto text-[10px] text-muted-foreground">{notReady}</span> : null}
    </DropdownMenuRadioItem>
  );
}

/// `showDuplicate` est faux dans NetsuFlow : une composition est créée, jamais
/// modifiée en place, donc il n'y a rien dont garder une copie. Y proposer la
/// case reviendrait à offrir un garde-fou contre un risque inexistant.
export function EngineMenu({ showDuplicate = true }: { showDuplicate?: boolean } = {}) {
  const { t } = useTranslation(["chat", "common"]);
  const provider = useApp((s) => s.chatProvider);
  const agentId = useApp((s) => s.chatAgentId);
  const setEngine = useApp((s) => s.setChatEngine);
  const model = useApp((s) => s.chatModel);
  const setModel = useApp((s) => s.setChatModel);
  const mode = useApp((s) => s.chatMode);
  const setMode = useApp((s) => s.setChatMode);
  const thinking = useApp((s) => s.chatThinking);
  const setThinking = useApp((s) => s.setChatThinking);
  const duplicateFirst = useApp((s) => s.chatDuplicateFirst);
  const setDuplicateFirst = useApp((s) => s.setChatDuplicateFirst);
  const agents = useApp((s) => s.chatAgents);
  const modelsByProvider = useApp((s) => s.chatModels);
  const modelsBusy = useApp((s) => s.chatModelsBusy);
  const loadModels = useApp((s) => s.chatLoadModels);
  const ensureAgents = useApp((s) => s.chatEnsureAgents);

  // Mémorisé sur `agents` : recalculé à chaque rendu, `buildEngines` rendait des
  // objets neufs, donc `current` changeait d'identité en permanence — et l'effet
  // qui charge les modèles se rejouait après CHAQUE rendu (cf. plus bas).
  const engines = useMemo(() => buildEngines(agents), [agents]);
  // Vue du socle « modèle + effort ». `null` = personne n'a encore navigué, on suit le moteur.
  //
  // Décider à l'ouverture ne marchait pas : au premier clic les agents ne sont souvent pas encore
  // sondés, `current` est indéfini, « ce moteur a-t-il un effort ? » répond non, et la fenêtre
  // restait bloquée sur le catalogue jusqu'à ce qu'on la referme. Dérivée, elle bascule d'elle-même
  // dès que la réponse arrive.
  const [view, setView] = useState<"effort" | "model" | null>(null);
  // Menu piloté : le socle a besoin de savoir s'il est ouvert (cf. son libellé plus bas).
  const [menuOpen, setMenuOpen] = useState(false);
  const engineId = toEngineId(provider, agentId);
  const current = engines.find((e) => e.id === engineId);
  const cli = useMemo(() => engines.filter((e) => e.kind === "cli"), [engines]);
  const api = useMemo(() => engines.filter((e) => e.kind === "api"), [engines]);

  const listed = current ? modelsByProvider[current.modelsFrom] : undefined;
  // Une liste vide n'est jamais la vérité — aucun moteur n'a zéro modèle. Le
  // repli tient donc lieu de réponse tant que la vraie liste n'est pas là : un
  // core plus ancien, sans `chat:models`, ou pas de réseau.
  const live = listed?.models ?? [];
  const models = live.length ? live : (current?.fallbackModels ?? []);
  const shown = live.length ? listed?.source : "curated";
  const loading = !!current && modelsBusy === current.modelsFrom;

  // Les agents se détectent tout seuls. Rien ne le faisait hors du panneau
  // NetsuPilot : dans NetsuFlow la liste restait vide jusqu'à un passage par
  // les réglages et un « Re-scanner » à la main.
  useEffect(() => { ensureAgents(); }, [ensureAgents]);

  // Dépendre du NOM du fournisseur, pas de l'objet moteur. Sur l'objet, l'effet
  // repartait à chaque rendu ; tant que la liste se met en cache `loadModels`
  // sort tout de suite, mais dès qu'elle échoue (core ancien, pas de réseau) il
  // pose puis retire son drapeau « en cours » — deux écritures, donc un nouveau
  // rendu, donc l'effet à nouveau : la boucle infinie qui rechargeait les
  // modèles sans fin et empêchait les menus de tenir ouverts.
  // Aucune détection n'a encore abouti : `chatAgents` est nul au démarrage, pas vide.
  const probing = agents === null;
  const shownView = view ?? (current?.thinking ? "effort" : "model");
  const modelsFrom = current?.modelsFrom;
  useEffect(() => {
    if (modelsFrom) void loadModels(modelsFrom);
  }, [modelsFrom, loadModels]);

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      {/* ---- Socle 1 : l'agent ------------------------------------------ */}
      <DropdownMenu onOpenChange={(open) => { if (open) ensureAgents(); }}>
        <DropdownMenuTrigger render={<Socle />}>
          <EngineIcon engine={current} className="size-3.5 shrink-0" />
          <span className="truncate text-xs font-medium text-foreground">{current?.label ?? t("engine.none")}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-64">
          {/* Un seul groupe radio : agents et clés sont le même genre de choix. */}
          <DropdownMenuRadioGroup value={engineId} onValueChange={(v) => setEngine(String(v))}>
            {cli.length > 0 && (
              <>
                <DropdownMenuLabel>{t("engine.agents")}</DropdownMenuLabel>
                {cli.map((engine) => <EngineRow key={engine.id} engine={engine} notReady={t("engine.notReady")} />)}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuLabel>{t("engine.apiKeys")}</DropdownMenuLabel>
            {api.map((engine) => <EngineRow key={engine.id} engine={engine} notReady={t("engine.notReady")} />)}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ---- Socle 2 : le modèle ET l'effort, sous UN bouton ---------------
          Deux réglages du même moteur, donc un seul socle — et le libellé de
          l'effort n'y est PAS écrit : il change de largeur à chaque cran, et la
          barre entière sautait sous le curseur pendant qu'on le glissait. Le
          mot « Effort », lui, ne bouge jamais.

          Le menu a deux vues dans une seule fenêtre, jamais deux fenêtres
          imbriquées : le curseur d'abord (c'est le réglage qu'on vient
          changer), et la ligne du modèle y est un bouton qui bascule sur le
          catalogue. Largeur fixe pour les deux, sinon la fenêtre se redimensionne
          au changement de vue. */}
      <DropdownMenu open={menuOpen}
        onOpenChange={(open) => { setMenuOpen(open); if (open) { setView(null); ensureAgents(); } }}>
        <DropdownMenuTrigger render={<Socle />}>
          <span className="truncate text-xs text-foreground">{shortModel(model, t("engine.default"))}</span>
          {/* Fermé, le socle dit le palier — c'est l'information utile. Ouvert, il dit « Effort » :
              le nom du palier change de largeur à chaque cran, et la barre entière sautait sous le
              curseur pendant qu'on le glissait. Un seul saut à la fermeture, aucun pendant le geste. */}
          {current?.thinking ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {menuOpen ? t("engine.effort") : t(`thinking.${thinking}`)}
            </span>
          ) : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72 p-1">
          {/* Tant que la détection n'a jamais répondu, on ne SAIT pas quelle vue est la bonne :
              attendre une seconde vaut mieux qu'ouvrir sur la mauvaise. */}
          {probing ? (
            <div className="grid h-[76px] place-items-center text-xs text-muted-foreground">
              <Spinner className="size-4" />
            </div>
          ) : shownView === "effort" ? (
            <ThinkingSlider
              value={thinking}
              onChange={setThinking}
              model={shortModel(model, t("engine.default"))}
              onPickModel={() => setView("model")}
            />
          ) : (
            <>
              <div className="flex items-center gap-1 px-1 pt-0.5">
                {current?.thinking ? (
                  <Button size="icon-sm" variant="ghost" className="size-6"
                    aria-label={t("common:action.back")}
                    onClick={(e) => { e.preventDefault(); setView("effort"); }}>
                    <ChevronLeft className="size-3.5" />
                  </Button>
                ) : null}
                <span className="text-xs font-medium text-muted-foreground">{t("engine.model")}</span>
                {/* La provenance : « votre clé dit ceci » et « liste de secours »
                    ne méritent pas la même confiance, et l'écart est invisible
                    autrement. */}
                {shown ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="cursor-default text-[10px] text-muted-foreground" />}>
                      {t(`engine.source.${shown}`)}
                    </TooltipTrigger>
                    <TooltipContent>{t(`engine.sourceHint.${shown}`)}</TooltipContent>
                  </Tooltip>
                ) : null}
                <span className="flex-1" />
                <Tooltip>
                  <TooltipTrigger render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-6"
                      aria-label={t("engine.refreshModels")}
                      disabled={!current || loading}
                      onClick={(e) => { e.preventDefault(); if (current) void loadModels(current.modelsFrom, true); }}
                    />
                  }>
                    <RefreshCw className={loading ? "size-3 animate-spin" : "size-3"} />
                  </TooltipTrigger>
                  <TooltipContent>{t("engine.refreshModels")}</TooltipContent>
                </Tooltip>
              </div>

              <DropdownMenuRadioGroup value={model || "default"} onValueChange={(v) => setModel(String(v) === "default" ? "" : String(v))}>
                <DropdownMenuRadioItem value="default">{t("engine.default")}</DropdownMenuRadioItem>
                <div className="max-h-56 overflow-y-auto">
                  {models.map((m) => (
                    <DropdownMenuRadioItem key={m} value={m}>
                      <span className="truncate text-xs">{m}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </div>
              </DropdownMenuRadioGroup>

              {/* Champ libre : la liste au-dessus est un raccourci, pas un
                  catalogue fermé — un endpoint local ou un modèle tout juste sorti
                  s'y tape. Stoppe la propagation pour que la saisie clavier ne
                  déclenche pas la navigation typeahead du menu. */}
              <div className="px-1 pb-0.5 pt-1" onKeyDown={(e) => e.stopPropagation()}>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={t("engine.freeId")}
                  className="h-7 text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ---- Socle 3 : les permissions ----------------------------------- */}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Socle />}>
          <span className="truncate text-xs text-foreground">
            {t(`mode.${mode === "read-only" ? "readonly" : mode}`)}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-72">
          <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(String(v) as ChatPermMode)}>
            <DropdownMenuLabel>{t("engine.permissions")}</DropdownMenuLabel>
            {/* La description est DANS la ligne, pas dans une infobulle : une
                permission est une décision, et cacher ce qu'elle veut dire
                derrière un survol fait deviner au pire moment. */}
            {MODES.map(({ id, icon: Icon, tone }) => (
              <DropdownMenuRadioItem key={id} value={id} className="items-start gap-2 py-1.5">
                <Icon className={`mt-0.5 size-4 shrink-0 ${tone ?? ""}`} />
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium">{t(`mode.${id === "read-only" ? "readonly" : id}`)}</span>
                  <span className="text-[11px] leading-snug text-muted-foreground">
                    {t(`modeTitle.${id === "read-only" ? "readonly" : id}`)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>

          {/* Orthogonale au mode, donc à part plutôt qu'en quatrième option que
              personne ne pouvait combiner avec « demander ». Décochée par
              défaut : dupliquer sans qu'on l'ait demandé laisse des timelines
              orphelines dans le projet. */}
          {showDuplicate ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={duplicateFirst}
                onCheckedChange={(next: boolean) => setDuplicateFirst(Boolean(next))}
                className="items-start gap-2 py-1.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-xs font-medium">{t("duplicate.title")}</span>
                  <span className="text-[11px] leading-snug text-muted-foreground">{t("duplicate.hint")}</span>
                </span>
              </DropdownMenuCheckboxItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
