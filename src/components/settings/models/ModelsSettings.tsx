import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AudioLines, Download, Eraser, FileUp, Film, Gauge,
  HardDrive, Image, Layers3, Mic, Package, RefreshCw, RotateCw, ScanFace, ScanSearch,
  Scissors, Search, Sparkles, Trash2, WandSparkles, Check, AlertTriangle, X,
  ArrowUpNarrowWide, ArrowDownWideNarrow, type LucideIcon,
} from "lucide-react";
import {
  MODEL_REGISTRY, TASK_ORDER, TASK_LABELS, fmtSize,
  type ModelEntry, type ModelTask,
} from "@/lib/modelRegistry";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ErrorReportButton } from "@/components/common/ErrorReportButton";
import { useModelManager, type ModelManager } from "./useModelManager";
import { useSearchModel, type SearchModelPicker } from "./useSearchModel";
import { isModelCompatible, useCompatibility } from "@/hooks/useCompatibility";

// Tri APPLIQUÉ DANS chaque section (les sections gardent l'ordre métier de TASK_ORDER).
// `default` = ordre du catalogue (recommandé en tête).
type SortKey = "default" | "size" | "vram" | "name";
type SortDir = "asc" | "desc";
const SORTS: SortKey[] = ["default", "size", "vram", "name"];

// Sens attendu quand on choisit un critère : les lourds d'abord pour taille/VRAM, A→Z pour le nom.
// Changer de critère y ramène ; la bascule inverse ensuite.
const NATURAL_DIR: Record<SortKey, SortDir> = { default: "asc", size: "desc", vram: "desc", name: "asc" };

// Actions de rangée réduites à leur icône : le libellé n'apparaît qu'après une pause délibérée sur
// l'icône, pour ne pas couvrir la ligne dès que le curseur la traverse en descendant la liste.
// Le délai vit sur le Provider (Base UI ne l'expose pas sur Root) → un provider local par bulle.
const HOVER_TIP_DELAY_MS = 600;

const TASK_ICONS: Record<ModelTask, LucideIcon> = {
  detect: ScanSearch,
  search: Search,
  face: ScanFace,
  "voice-asr": Mic,
  "voice-vad": AudioLines,
  upscale: WandSparkles,
  restore: Sparkles,
  interpolate: Gauge,
  depth: Layers3,
  "matte-video": Film,
  "matte-image": Image,
  segment: Scissors,
  "object-removal": Eraser,
};

function SlowTooltip({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={HOVER_TIP_DELAY_MS}>
      <Tooltip>{children}</Tooltip>
    </TooltipProvider>
  );
}

// Taille réelle pour un modèle COMPLET ; un téléchargement partiel ne doit jamais remplacer la
// taille totale attendue dans la liste (sinon Lucida affiche « 14 Mo » pendant ses ~844 Mo de DL).
const sizeOf = (m: ModelEntry, mgr: ModelManager) => {
  const st = mgr.status[m.id];
  return st?.installed && st.sizeBytes ? st.sizeBytes : m.sizeBytes;
};

const MODEL_HINT_KEYS: Partial<Record<string, string>> = {
  transnetv2: "derush:shared.modelHintTransnet",
  omnishotcut: "derush:shared.modelHintOmni",
  autoshot: "derush:shared.modelHintAutoShot",
  "whisper-turbo": "voice:shared.asr.whisperTurbo.hint",
  "parakeet-v3": "voice:shared.asr.parakeetV3.hint",
  whisperx: "voice:shared.asr.whisperx.hint",
  "canary-1b-v2": "voice:shared.asr.canary.hint",
  "sam2.1-large": "roto:sam.large",
  "sam2.1": "roto:sam.base",
};

function modelHintKeys(m: ModelEntry): string[] {
  const keys = [`models:catalogHint.${m.id}`];
  const exact = MODEL_HINT_KEYS[m.id];
  if (exact) keys.push(exact);
  if (m.task === "upscale" || m.task === "interpolate") keys.push(`upscale:modelHint.${m.id}`);
  if (m.task === "depth") keys.push(`upscale:depthModelHint.${m.id}`);
  if (m.task === "matte-image" || m.task === "matte-video") keys.push(`upscale:segModelHint.${m.id}`);
  if (m.task === "object-removal" || m.task === "matte-video") keys.push(`roto:engineHint.${m.id}`);
  // Ne jamais finir par la description générique de la catégorie : i18next la considérerait comme
  // une traduction valide et masquerait le `hint` propre au modèle passé en defaultValue.
  return keys;
}

function sortModels(models: ModelEntry[], key: SortKey, dir: SortDir, mgr: ModelManager): ModelEntry[] {
  if (key === "default") return dir === "asc" ? models : [...models].reverse();
  const cmp = key === "name"
    ? (a: ModelEntry, b: ModelEntry) => a.label.localeCompare(b.label, "fr")
    : key === "vram"
      ? (a: ModelEntry, b: ModelEntry) => a.vramGB - b.vramGB || sizeOf(a, mgr) - sizeOf(b, mgr)
      : (a: ModelEntry, b: ModelEntry) => sizeOf(a, mgr) - sizeOf(b, mgr);
  const arr = [...models].sort(cmp);
  return dir === "desc" ? arr.reverse() : arr;
}

// Badge de licence : NC (non-commercial) en rouge, permissif discret.
function LicenseBadge({ m }: { m: ModelEntry }) {
  return m.commercialUse
    ? <Badge variant="secondary" className="text-muted-foreground">{m.license}</Badge>
    : <Badge className="border-destructive/40 bg-destructive/10 text-destructive">{m.license}</Badge>;
}

function RemoveButton({ id, mgr }: { id: string; mgr: ModelManager }) {
  const { t } = useTranslation(["models", "common"]);
  return (
    <SlowTooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => mgr.remove(id)} aria-label={t("common:action.delete")}>
        <Trash2 className="h-3.5 w-3.5" />
      </Button>} />
      <TooltipContent>{t("common:action.delete")} — {t("models:status.removeTip")}</TooltipContent>
    </SlowTooltip>
  );
}

// Variante de recherche : « Actif » ou « Utiliser » + confirmation, car la bascule laisse la nouvelle
// variante devant SON index (vide au premier choix) — l'ancien reste sur disque, intact.
function SearchModelAction({ m, picker }: { m: ModelEntry; picker: SearchModelPicker }) {
  const { t } = useTranslation(["models", "common"]);
  const [open, setOpen] = useState(false);
  const entry = picker.entry(m.id);
  if (!entry || !entry.installed) return null;
  if (entry.active) {
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge className="border-primary/40 bg-primary/10 text-primary">{t("models:search.active")}</Badge>} />
        <TooltipContent>{t("models:search.activeTip")}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="sm" disabled={picker.busy === m.id} onClick={() => setOpen(true)}>
          {picker.busy === m.id ? <Spinner className="size-3.5" /> : <Check className="size-3.5" />} {t("models:search.use")}
        </Button>} />
        <TooltipContent>{t("models:search.useTip")}</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>{t("models:search.switchTitle")}</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {entry.indexedClips > 0
              ? t("models:search.switchPartial", { model: m.label, clips: entry.indexedClips })
              : t("models:search.switchEmpty", { model: m.label })}
          </p>
          {picker.error && <p className="text-xs text-destructive">{picker.error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>{t("common:action.cancel")}</Button>
            <Button size="sm" onClick={async () => { if (await picker.use(m.id)) setOpen(false); }}>
              {t("models:search.switchConfirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Deux modèles exclusifs se disputent la MÊME distribution pip : SAMURAI et SAM2Long fournissent
// tous deux le paquet `sam2`. Installer le second effaçait le premier sans le dire ; on demande.
function ConflictDialog({ mgr }: { mgr: ModelManager }) {
  const { t } = useTranslation(["models", "common"]);
  const conflict = mgr.conflict;
  const label = (id: string) => MODEL_REGISTRY.find((entry) => entry.id === id)?.label ?? id;
  return (
    <Dialog open={conflict !== null} onOpenChange={(open) => { if (!open) mgr.dismissConflict(); }}>
      <DialogContent className="max-w-md">
        <DialogTitle>{t("models:conflict.title")}</DialogTitle>
        {conflict && (
          <>
            <p className="text-sm text-muted-foreground">
              {t("models:conflict.body", {
                model: label(conflict.id),
                other: conflict.blockedBy.map(label).join(", "),
              })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={mgr.dismissConflict}>{t("common:action.cancel")}</Button>
              <Button size="sm" onClick={() => { const { id } = conflict; mgr.dismissConflict(); void mgr.download(id, true); }}>
                {t("models:conflict.replace")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModelRow({ m, mgr, search }: { m: ModelEntry; mgr: ModelManager; search?: SearchModelPicker }) {
  const { t } = useTranslation(["models", "common", "derush", "voice", "upscale", "roto"]);
  const st = mgr.status[m.id];
  const installed = st?.installed ?? false;
  const dl = mgr.downloading[m.id];
  const stage = mgr.stages[m.id];
  const busy = dl !== undefined;
  const removing = mgr.removing[m.id] ?? false;
  const err = mgr.errors[m.id];
  const size = sizeOf(m, mgr);
  const hint = m.hint ? t(modelHintKeys(m), { defaultValue: m.hint }) : "";
  // VRAM TOTALE de la carte, pas la libre : « ne tiendra jamais » est une propriété du matériel.
  // Sans GPU NVIDIA mesurable (mgr.gpu null), on n'avertit sur rien plutôt que d'alarmer à tort.
  const vramHaveGB = mgr.gpu ? Math.round(mgr.gpu.totalMB / 1024) : 0;
  const tooBig = !!mgr.gpu && m.vramGB > 0 && m.vramGB > vramHaveGB;

  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-1 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{m.label}</span>
          {m.default && <Badge variant="secondary" className="text-[10px]">{t("badge.default")}</Badge>}
          <LicenseBadge m={m} />
          {m.tier === "heavy" && <Badge variant="secondary" className="text-[10px] text-[var(--color-warn)]">{t("badge.heavy")}</Badge>}
          {m.exclusive && (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="secondary" className="text-[10px] text-[var(--color-warn)]">{t("badge.exclusive")}</Badge>} />
              <TooltipContent>{t("badge.exclusiveTip")}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {hint && (
          <Tooltip>
            <TooltipTrigger render={<p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>} />
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        )}
        {err && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <p className="flex min-w-0 items-center gap-1 text-xs text-destructive"><AlertTriangle className="h-3 w-3 shrink-0" /> {err}</p>
            <ErrorReportButton
              error={err}
              subject={`Échec du téléchargement du modèle « ${m.label} » (${m.id})`}
              module="settings"
              moduleLabel="Paramètres"
            />
          </div>
        )}
      </div>

      <div className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        <div>{fmtSize(size)}</div>
        {m.vramGB > 0 && (
          tooBig ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <div className="flex items-center justify-end gap-1 text-[10px] text-[var(--color-warn)]">
                    <AlertTriangle className="h-3 w-3" /> {m.vramGB} Go VRAM
                  </div>
                }
              />
              <TooltipContent>{t("vramShort", { need: m.vramGB, have: vramHaveGB, gpu: mgr.gpu?.name })}</TooltipContent>
            </Tooltip>
          ) : (
            <div className="text-[10px] opacity-70">{m.vramGB} Go VRAM</div>
          )
        )}
      </div>

      {search && m.task === "search" && <div className="shrink-0"><SearchModelAction m={m} picker={search} /></div>}

      <div className="w-32 shrink-0 text-right">
        {removing ? (
          <div className="flex items-center justify-end gap-1.5">
            <span className="text-[10px] text-muted-foreground">{t("status.removing")}</span>
            <Progress value={null} className="h-1 w-12" />
          </div>
        ) : busy ? (
          <div className="flex items-center justify-end gap-1.5">
            {/* Un pourcentage tant qu'on télécharge, le NOM de l'étape ensuite : vérification et
                installation prennent des dizaines de secondes sur une barre indéterminée, et sans
                libellé elles passaient pour un téléchargement qui recommence. */}
            <span className="min-w-8 text-right text-[10px] tabular-nums text-muted-foreground">
              {dl != null ? `${dl}%` : t(`stage.${stage || "install"}`, { defaultValue: "…" })}
            </span>
            <Progress value={dl} className="h-1 w-12" />
            <Tooltip>
              <TooltipTrigger render={<button type="button" onClick={() => mgr.cancel(m.id)} aria-label={t("action.cancelDownload")} className="rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground">
                <X className="size-3" />
              </button>} />
              <TooltipContent>{t("common:action.cancel")}</TooltipContent>
            </Tooltip>
          </div>
        ) : st?.partial ? (
          <div className="flex items-center justify-end gap-1">
            <SlowTooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="text-[var(--color-warn)]" onClick={() => mgr.download(m.id)} aria-label={t("action.resume")}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>} />
              <TooltipContent>{t("action.resume")} — {t("action.resumeTip")}</TooltipContent>
            </SlowTooltip>
            <RemoveButton id={m.id} mgr={mgr} />
          </div>
        ) : m.bundled ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Package className="h-3.5 w-3.5" /> {t("status.bundled")}</span>} />
            <TooltipContent>{t("status.bundledTip")}</TooltipContent>
          </Tooltip>
        ) : installed ? (
          <div className="flex items-center justify-end gap-1">
            <span className="inline-flex items-center gap-1 text-xs text-[var(--color-ok)]"><Check className="h-3.5 w-3.5" /> {t("status.installed")}</span>
            <RemoveButton id={m.id} mgr={mgr} />
          </div>
        ) : m.manual ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => mgr.importFile(m.id)}>
            <FileUp className="h-3.5 w-3.5" /> {t("common:action.import")}
          </Button>
        ) : m.autoFetch ? (
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><RefreshCw className="h-3.5 w-3.5" /> {fmtSize(0)} · {t("status.auto")}</span>} />
            <TooltipContent>{t("status.autoTip")}</TooltipContent>
          </Tooltip>
        ) : (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => mgr.download(m.id)}>
            <Download className="h-3.5 w-3.5" /> {t("action.download")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ModelsSettings() {
  const { t } = useTranslation(["models", "setup"]);
  const mgr = useModelManager();
  const searchPicker = useSearchModel();
  const { status: compatibility } = useCompatibility();
  const [sort, setSort] = useState<SortKey>("default");
  const [dir, setDir] = useState<SortDir>(NATURAL_DIR.default);
  const [advanced, setAdvanced] = useState(false);
  // Le catalogue complet dépasse la centaine d'entrées : listé d'un bloc, il ne se lit plus. On ne
  // montre par défaut que la sélection courante de chaque tâche (2 à 6 modèles couvrant des situations
  // différentes), et « Avancé » révèle le reste. Un modèle avancé DÉJÀ INSTALLÉ reste toujours visible,
  // sinon on ne pourrait plus le supprimer sans deviner où il se cache.
  const listed = MODEL_REGISTRY.filter((m) => isModelCompatible(m.id, compatibility)
    && (mgr.loading || mgr.status[m.id]?.available !== false));
  const shown = listed.filter((m) => advanced || !m.advanced || mgr.status[m.id]?.installed || mgr.status[m.id]?.partial);
  const hiddenCount = listed.length - shown.length;
  const groups = TASK_ORDER
    .map((task) => ({ task, models: shown.filter((m) => m.task === task) }))
    .filter((g) => g.models.length > 0);

  return (
    <div className="space-y-6">
      <ConflictDialog mgr={mgr} />
      {mgr.restartRequired && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 p-3">
          <p className="text-xs text-foreground">{t("setup:restartHint")}</p>
          <Button size="sm" onClick={() => mgr.restart()}>
            <RotateCw className="size-4" /> {t("setup:restartApp")}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle pressed={advanced} onPressedChange={setAdvanced} className="mr-auto gap-1.5">
                <Layers3 className="size-3.5" />
                {t("advanced.label")}
                {!advanced && hiddenCount > 0 && (
                  <Badge variant="secondary" className="text-[10px] tabular-nums">{hiddenCount}</Badge>
                )}
              </Toggle>
            }
          />
          <TooltipContent>{t("advanced.tip")}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="icon" aria-label={t(`sort.${sort}Tip`)}>
                {dir === "asc" ? <ArrowUpNarrowWide className="size-4" /> : <ArrowDownWideNarrow className="size-4" />}
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={sort}
              onValueChange={(value) => {
                const key = String(value) as SortKey;
                setSort(key);
                setDir(NATURAL_DIR[key]);
              }}
            >
              {SORTS.map((key) => (
                <DropdownMenuRadioItem key={key} value={key}>{t(`sort.${key}`)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setDir((value) => (value === "asc" ? "desc" : "asc"))}>
              {dir === "asc" ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
              {t(`sort.${dir === "asc" ? "desc" : "asc"}`)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                {mgr.loading ? <Spinner className="size-3.5" /> : <><HardDrive className="size-3.5" /><span className="tabular-nums text-foreground">{fmtSize(mgr.diskTotal)}</span></>}
              </span>
            }
          />
          <TooltipContent>{t("disk")} {fmtSize(mgr.diskTotal)}</TooltipContent>
        </Tooltip>
      </div>

      {groups.map((g) => {
        const TaskIcon = TASK_ICONS[g.task];
        // Modèle utilisable = installé sur disque OU récupéré auto au 1er usage (bundlé + cache lib).
        const usable = g.models.some((m) => mgr.status[m.id]?.installed ?? false);
        return (
          <section key={g.task}>
            <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <TaskIcon className="size-3.5 text-primary" />
              {TASK_LABELS[g.task as ModelTask]}
            </h3>
            {!usable && (
              <p className="mb-1 flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("noneInstalled")}
              </p>
            )}
            {/* Dit AVANT le clic que ces moteurs se remplacent : le découvrir en voyant le premier
                passer à « non installé » après avoir posé le second serait pris pour une panne. */}
            {g.models.some((m) => m.exclusive) && (
              <p className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-warn)]">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {t("badge.exclusiveTip")}
              </p>
            )}
            <div className="rounded-lg border border-border bg-card/40 px-3">
              {sortModels(g.models, sort, dir, mgr).map((m) => (
                <ModelRow key={m.id} m={m} mgr={mgr} search={g.task === "search" ? searchPicker : undefined} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
