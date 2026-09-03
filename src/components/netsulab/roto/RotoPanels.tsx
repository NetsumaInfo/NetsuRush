import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { modelById } from "@/lib/modelRegistry";
import {
  Download, Eraser, Route, ChevronDown, ChevronLeft, ChevronRight, StepBack, StepForward,
  Trash2, Copy, Undo2, Dices, FlaskConical, RotateCcw, Sparkles, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ColorPicker } from "@/components/ui/color-picker";
import { NumberSpin } from "@/components/ui/number-spin";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ModelPicker, ModelsCta, useInstalledModels, useRequireModel } from "@/components/upscale/ModelPicker";
import { cn } from "@/lib/utils";
import {
  BATCHED_REFINE, DEFAULT_MATTE_PARAMS, DEFAULT_POST, DEFAULT_REMOVE_PARAMS, EXPORT_FMT_KEY,
  EXPORT_FORMATS, MATTE_SIZE_STEPS, REMOVE_QUALITY_STEPS, SAM_MODELS, VIEW_MODES, isDefaultPost,
  type RotoPostState, type RotoRemoveParams, type RotoViewState, type RotoViewMode,
} from "./rotoShared";
import type { RotoSession } from "./useRotoSession";

// Panneaux du volet droit du Roto Studio (RotoStudio ne fait que composer) : modèle SAM, boutons de
// suivi (complet + partiels directionnels), affinage non destructif du masque, moteur+action.

// Sélecteur de modèle de segmentation. N'affiche que les modèles SAM installés, plus l'entrée de
// téléchargement (Paramètres › Modèles). Changer de modèle rouvre la session (recharge SAM).
export function SamModelRow({ model, installed, onChoose, disabled }: {
  model: string; installed: string[]; onChoose: (id: string) => void; disabled: boolean;
}) {
  const { t } = useTranslation("roto");
  // Statut frais (rafraîchi à la fin d'un téléchargement) ; `installed` (lu à l'ouverture de la
  // session) sert de repli tant que la liste n'est pas revenue du core.
  const { ready, has } = useInstalledModels();
  useRequireModel(model);
  const opts = SAM_MODELS
    .filter((m) => (ready ? has(m.id) : installed.includes(m.id)))
    .map((m) => ({ ...m, hint: t(m.hintKey) }));
  return (
    <div className="space-y-1.5">
      <ModelPicker items={opts} value={model} onChange={onChoose} disabled={disabled}
        empty={t("panels.noSam")} />
    </div>
  );
}

// Suivi : bouton principal (complet, avant+arrière depuis les frames annotées), pas-à-pas (UNE
// image à la fois — vérification chirurgicale), re-propagation PARTIELLE directionnelle depuis la
// frame courante, réinitialisation du suivi (points conservés) et dédup animation.
export function TrackButtons({ s, running }: { s: RotoSession; running: boolean }) {
  const { t } = useTranslation("roto");
  const canTrack = !!s.pointCount && !running;
  return (
    <div className="space-y-1.5">
      {s.points.length > 0 && (
        <Button variant="ghost" size="sm" className="w-full" onClick={() => s.clearPoints({ frame: s.frame })} disabled={running}>
          <Eraser className="h-3.5 w-3.5" /> {t("track.clearFramePoints")}
        </Button>
      )}
      <Button className="w-full" disabled={!canTrack} onClick={() => s.track("all")}>
        <Route className="h-4 w-4" /> {t("track.trackAll")}
      </Button>
      <div className="flex gap-1.5">
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" className="flex-1" disabled={!canTrack} onClick={() => s.trackStep(-1)}>
            <StepBack className="h-3.5 w-3.5" /> {t("track.stepBack")}
          </Button>} />
          <TooltipContent>{t("track.stepBackTip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="sm" className="flex-1" disabled={!canTrack} onClick={() => s.trackStep(1)}>
            {t("track.stepFwd")} <StepForward className="h-3.5 w-3.5" />
          </Button>} />
          <TooltipContent>{t("track.stepFwdTip")}</TooltipContent>
        </Tooltip>
      </div>
      {s.tracked && (
        <div className="flex gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" className="flex-1" disabled={!canTrack} onClick={() => s.track("backward")}>
              <ChevronLeft className="h-3.5 w-3.5" /> {t("track.retrackBack")}
            </Button>} />
            <TooltipContent>{t("track.retrackBackTip")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="sm" className="flex-1" disabled={!canTrack} onClick={() => s.track("forward")}>
              {t("track.retrackFwd")} <ChevronRight className="h-3.5 w-3.5" />
            </Button>} />
            <TooltipContent>{t("track.retrackFwdTip")}</TooltipContent>
          </Tooltip>
        </div>
      )}
      {s.tracked && (
        <div className="flex gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="sm" className="flex-1" disabled={running} onClick={() => s.dedupe()}>
              <Copy className="h-3.5 w-3.5" /> {t("track.dedupe")}
            </Button>} />
            <TooltipContent>{t("track.dedupeTip")}</TooltipContent>
          </Tooltip>
          {s.deduped && (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={running} onClick={() => s.dedupeRestore()} aria-label={t("track.restoreMattesAria")}>
                <Undo2 className="h-3.5 w-3.5" />
              </Button>} />
              <TooltipContent>{t("track.restoreMattesTip")}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={running} onClick={() => s.clearTracking()} aria-label={t("track.resetAria")}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>} />
            <TooltipContent>{t("track.resetTip")}</TooltipContent>
          </Tooltip>
        </div>
      )}
      {s.tracked && (
        <p className="text-center text-xs text-[var(--color-ok)]">{t("track.upToDate")}</p>
      )}
    </div>
  );
}

// Mode d'affichage du masque : Édition (overlay teinté + opacité), Matte N&B, Alpha (damier),
// Fond couleur — + contours par objet. Rendu côté python, opacité côté client (instantanée).
export function ViewPanel({ view, onChange, disabled }: {
  view: RotoViewState; onChange: (patch: Partial<RotoViewState>) => void; disabled: boolean;
}) {
  const { t } = useTranslation("roto");
  return (
    <div className="space-y-2">
      <ToggleGroup className="w-full" value={[view.mode]}
        onValueChange={(v) => v[0] && onChange({ mode: v[0] as RotoViewMode })}>
        {VIEW_MODES.map((m) => (
          <Tooltip key={m.id}>
            <TooltipTrigger render={<ToggleGroupItem value={m.id} className="flex-1 text-[11px]" disabled={disabled}>
              {t(m.labelKey)}
            </ToggleGroupItem>} />
            <TooltipContent>{t(m.hintKey)}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger render={<Toggle size="sm" pressed={view.outline} disabled={disabled}
            onPressedChange={(on) => onChange({ outline: on })} aria-label={t("view.outline")}>
            {t("view.outline")}
          </Toggle>} />
          <TooltipContent>{t("view.outlineTip")}</TooltipContent>
        </Tooltip>
        {view.mode === "bgcolor" && (
          <Tooltip>
            <TooltipTrigger render={<span>
              <ColorPicker value={view.bg} onChange={(c) => onChange({ bg: c })} ariaLabel={t("view.bgColorAria")} />
            </span>} />
            <TooltipContent>{t("view.bgColorTip")}</TooltipContent>
          </Tooltip>
        )}
      </div>
      {view.mode === "edit" && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{t("view.opacity")}</span>
            <span className="tabular-nums">{view.opacity} %</span>
          </div>
          <Slider min={10} max={100} step={5} value={[view.opacity]} disabled={disabled}
            onValueChange={(v) => { const n = Array.isArray(v) ? v[0] : v; if (n != null) onChange({ opacity: n }); }} />
        </div>
      )}
    </div>
  );
}

// Affinage NON destructif du masque (appliqué à l'overlay en direct et cuit à l'export ; les mattes
// propagées ne bougent pas). Double-clic sur un libellé = remise à zéro du réglage.
export function PostPanel({ post, onChange, disabled }: {
  post: RotoPostState; onChange: (patch: Partial<RotoPostState>) => void; disabled: boolean;
}) {
  const { t } = useTranslation("roto");
  // Libellé ET explication viennent de la clé du réglage : un curseur dont on ne sait pas ce qu'il
  // fait ne se règle qu'au hasard, et deux d'entre eux (bavures du cadre, durcir l'alpha) ne sont
  // pas devinables depuis leur seul nom.
  const row = (key: keyof RotoPostState, min: number, max: number,
    { unit = "px", step = 1, reset = 0 }: { unit?: string; step?: number; reset?: number } = {}) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <Tooltip>
          <TooltipTrigger render={<span className="cursor-default select-none" onDoubleClick={() => onChange({ [key]: reset })}>{t(`post.${key}`)}</span>} />
          <TooltipContent className="max-w-[260px]">
            <p>{t(`post.${key}Hint`)}</p>
            <p className="mt-1 opacity-70">{t("post.resetTip")}</p>
          </TooltipContent>
        </Tooltip>
        <span className="tabular-nums">{post[key]}{post[key] !== reset ? ` ${unit}` : ""}</span>
      </div>
      <Slider min={min} max={max} step={step} value={[post[key]]} disabled={disabled}
        onValueChange={(v) => { const n = Array.isArray(v) ? v[0] : v; if (n != null) onChange({ [key]: n }); }} />
    </div>
  );
  // ORDRE = ordre de traitement côté python (nrroto.postproc) : nettoyer la matte, puis déplacer et
  // lisser sa forme, puis décider de son alpha. Lire le panneau de haut en bas décrit donc ce qui
  // arrive vraiment au masque — un ordre d'affichage libre laissait croire à des réglages
  // indépendants alors que chacun travaille sur le résultat du précédent.
  return (
    <div className="space-y-2.5">
      {row("holes", 0, 30)}
      {row("dots", 0, 30)}
      {row("border", 0, 10)}
      {row("grow", -20, 20)}
      {row("smooth", 0, 10)}
      {row("harden", 0, 100, { unit: "%" })}
      {row("feather", 0, 25)}
      {row("gamma", 0.2, 5, { unit: "", step: 0.1, reset: 1 })}
      {/* Sortie de secours : huit curseurs se poussent vite trop loin, et le double-clic ne remet à
          zéro qu'un réglage à la fois — il faudrait se souvenir de ceux qu'on a touchés. */}
      <ResetParams onReset={() => onChange(DEFAULT_POST)} disabled={disabled || isDefaultPost(post)} />
    </div>
  );
}

// La licence vient du registre, jamais du texte descriptif affiché dans l'interface.
const isNC = (engine: { id: string; label: string; hint: string }): boolean =>
  modelById(engine.id)?.commercialUse === false;

// Rangée « sélecteur de moteur + bouton d'action » réutilisée (matte fin, suppression). L'utilisateur
// choisit le modèle (MatAnyone/MatAnyone 2, MiniMax/FloED/…) puis lance ; le bouton porte l'icône/label.
// `onTest` (optionnel) = TEST sur l'image courante : le moteur tourne sur cette seule image et
// renvoie un aperçu — contrôle du rendu avant de lancer tout le plan.
export function EngineRow({ label, icon: Icon, engines, installed, disabled, onRun, onTest, testDisabled,
  onEngineChange }: {
  label: string; icon: LucideIcon; engines: { id: string; label: string; hint: string }[];
  installed?: string[]; disabled: boolean; onRun: (engine: string) => void;
  onTest?: (engine: string) => void; testDisabled?: boolean;
  onEngineChange?: (engine: string) => void;
}) {
  const { t } = useTranslation("roto");
  // N'affiche QUE les moteurs dont le modèle est téléchargé (comme le picker SAM). Repli sur la prop
  // `installed` (puis liste complète si elle est absente) tant que le statut frais n'est pas connu.
  const { ready, has } = useInstalledModels();
  const avail = engines
    .filter((e) => (ready ? has(e.id) : installed ? installed.includes(e.id) : true))
    .map((e) => ({ ...e, hint: t(`engineHint.${e.id}`, { defaultValue: e.hint }) }));
  const [eng, setEng] = useState(engines[0].id);
  const cur = avail.find((e) => e.id === eng) || avail[0];
  useRequireModel(eng, ready && !avail.length);
  // Le moteur RÉELLEMENT retenu peut différer du choix (modèle désinstallé → repli sur avail[0]) :
  // le parent doit connaître celui-là, c'est lui qui décide des réglages à afficher.
  const active = cur?.id;
  useEffect(() => { if (active) onEngineChange?.(active); }, [active, onEngineChange]);
  if (!cur) return <ModelsCta label={t("engineRow.noneInstalled", { label })} />;
  return (
    <div className="flex gap-1.5">
      <ModelPicker items={avail} value={cur.id} onChange={setEng} disabled={disabled}
        className="min-w-0 flex-1"
        itemExtra={(id) => {
          const e = avail.find((x) => x.id === id);
          return e && isNC(e) ? <Badge variant="outline" className="text-[10px]">NC</Badge> : null;
        }} />
      {onTest && (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon" disabled={testDisabled ?? disabled}
            onClick={() => onTest(cur.id)} aria-label={t("engineRow.testAria", { label })}>
            <FlaskConical className="h-4 w-4" />
          </Button>} />
          <TooltipContent>{t("engineRow.testTip")}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" size="icon" disabled={disabled} onClick={() => onRun(cur.id)} aria-label={label}>
          <Icon className="h-4 w-4" />
        </Button>} />
        <TooltipContent>{label} — {cur.hint}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// Retour aux valeurs d'usine d'UN groupe de réglages. Icône seule, alignée à droite : le rail est
// étroit et un bouton pleine largeur pèserait plus lourd que ce qu'il fait. Désactivé quand rien n'a
// bougé — il dit donc aussi si le groupe est encore d'origine.
function ResetParams({ onReset, disabled }: { onReset: () => void; disabled: boolean }) {
  const { t } = useTranslation("roto");
  return (
    <div className="flex justify-end">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="h-6 w-6 text-muted-foreground"
          disabled={disabled} onClick={onReset} aria-label={t("resetParams")}>
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>} />
        <TooltipContent>{t("resetParams")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

// Comparaison champ à champ contre les valeurs d'usine (des objets plats de nombres et de booléens) :
// c'est elle qui décide si la remise à zéro a encore quelque chose à remettre.
const isSameParams = <T extends object>(a: T, b: T) =>
  (Object.keys(b) as (keyof T)[]).every((k) => a[k] === b[k]);

// Libellé avec infobulle — motif commun aux réglages de suppression et de matte fin.
function ParamLabel({ text, hint }: { text: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="cursor-default select-none">{text}</span>} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

// Repli « Réglages avancés » : ce qui pilote le MODÈLE reste caché tant qu'on ne le cherche pas.
// La vue par défaut d'un moteur doit tenir en deux contrôles, sinon le rail redevient illisible.
function AdvancedRows({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-1.5">
      <Button variant="ghost" size="sm" className="h-6 w-full justify-start px-1 text-[11px] text-muted-foreground"
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} /> {label}
      </Button>
      {open && <div className="space-y-1.5 pl-1">{children}</div>}
    </div>
  );
}

// Réglages de la suppression d'objet, en DEUX familles séparées. Confondre les deux est ce qui
// rendait le moteur impilotable : « marge » décrit le masque, « graine » décrit le modèle.
//  - masque : marge d'effacement, plaque propre, raccord, grain (valables pour tout moteur)
//  - modèle : étapes, résolution, graine, fenêtre, recouvrement, économies de VRAM (diffusion seule)
type RemoveSlider = "steps" | "grow" | "harmonize" | "grain" | "window" | "overlap";

export function RemoveParamsRows({ value, onChange, disabled, diffusion }: {
  value: RotoRemoveParams;
  onChange: (v: RotoRemoveParams) => void;
  disabled: boolean;
  diffusion: boolean;
}) {
  const { t } = useTranslation("roto");
  const set = (patch: Partial<RotoRemoveParams>) => onChange({ ...value, ...patch });
  const row = (key: RemoveSlider, min: number, max: number, unit: string) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <ParamLabel text={t(`remove.${key}`)} hint={t(`remove.${key}Tip`)} />
        <span className="tabular-nums">{value[key]}{unit}</span>
      </div>
      <Slider min={min} max={max} step={1} value={[value[key]]} disabled={disabled}
        onValueChange={(v) => { const n = Array.isArray(v) ? v[0] : v; if (n != null) set({ [key]: n }); }} />
    </div>
  );
  const switchRow = (key: "plate" | "vaeTiling" | "cpuOffload") => (
    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <ParamLabel text={t(`remove.${key}`)} hint={t(`remove.${key}Tip`)} />
      <Toggle size="sm" variant="outline" pressed={value[key]} disabled={disabled}
        onPressedChange={(on) => set({ [key]: on })} aria-label={t(`remove.${key}`)}>
        {t(value[key] ? "remove.on" : "remove.off")}
      </Toggle>
    </div>
  );
  return (
    <div className="space-y-1.5 pl-1">
      {row("grow", 0, 24, " px")}
      {switchRow("plate")}
      {row("harmonize", 0, 100, " %")}
      {row("grain", 0, 100, " %")}
      {diffusion && row("steps", 4, 24, "")}
      {diffusion && (
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">
            <ParamLabel text={t("remove.quality")} hint={t("remove.qualityTip")} />
          </div>
          <ToggleGroup value={[String(value.quality)]} disabled={disabled}
            onValueChange={(v) => {
              const picked = Number(Array.isArray(v) ? v[0] : v);
              if (picked) set({ quality: picked });
            }}>
            {REMOVE_QUALITY_STEPS.map((step) => (
              <ToggleGroupItem key={step.value} value={String(step.value)} className="flex-1 text-[11px]">
                {t(step.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      {diffusion && (
        <AdvancedRows label={t("remove.advanced")}>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <ParamLabel text={t("remove.seed")} hint={t("remove.seedTip")} />
              <div className="flex items-center gap-1">
                <NumberSpin value={value.seed} min={0} max={999999} step={1} className="w-20"
                  ariaLabel={t("remove.seed")} onCommit={(n) => set({ seed: n })} />
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size="icon-sm" disabled={disabled}
                    onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}
                    aria-label={t("remove.reroll")}>
                    <Dices className="h-3.5 w-3.5" />
                  </Button>} />
                  <TooltipContent>{t("remove.rerollTip")}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
          {row("window", 17, 129, "")}
          {row("overlap", 0, 24, "")}
          {switchRow("vaeTiling")}
          {switchRow("cpuOffload")}
        </AdvancedRows>
      )}
      <ResetParams onReset={() => onChange(DEFAULT_REMOVE_PARAMS)}
        disabled={disabled || isSameParams(value, DEFAULT_REMOVE_PARAMS)} />
    </div>
  );
}

// Section « Matte fin » : le moteur d'affinage n'est PAS un export. Le ranger sous « Sortie », à
// côté d'Exporter, laissait croire qu'il produisait un fichier — c'est en réalité l'étape de
// qualité entre le suivi et la sortie, et son résultat remplace l'alpha affiché.
export function MatteFinePanel({ s, engines, disabled }: {
  s: RotoSession;
  engines: { id: string; label: string; hint: string }[];
  disabled: boolean;
}) {
  const { t } = useTranslation("roto");
  const { ready, has } = useInstalledModels();
  const avail = engines
    .filter((e) => (ready ? has(e.id) : s.installedModels.includes(e.id)))
    .map((e) => ({ ...e, hint: t(`engineHint.${e.id}`, { defaultValue: e.hint }) }));
  const [eng, setEng] = useState(engines[0].id);
  const cur = avail.find((e) => e.id === eng) || avail[0];
  useRequireModel(eng, ready && !avail.length);
  const p = s.matteParams;
  const set = (patch: Partial<typeof p>) => s.setMatteParams({ ...p, ...patch });
  const batched = !!cur && BATCHED_REFINE.has(cur.id);
  const slider = (key: string, value: number, min: number, max: number, onSet: (n: number) => void) => (
    <div className="space-y-1" key={key}>
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <ParamLabel text={t(key)} hint={t(`${key}Tip`)} />
        <span className="tabular-nums">{value}</span>
      </div>
      <Slider min={min} max={max} step={1} value={[value]} disabled={disabled}
        onValueChange={(v) => { const n = Array.isArray(v) ? v[0] : v; if (n != null) onSet(n); }} />
    </div>
  );
  if (!cur) return <ModelsCta label={t("engineRow.noneInstalled", { label: t("panels.matteFine") })} />;
  // Une seule rangée sélecteur + deux icônes, comme « Suppression d'objet » (cf. EngineRow) : les
  // libellés vivent dans les infobulles. En boutons texte, l'affinage était la seule étape du rail
  // à ne pas ressembler aux autres, et le sélecteur y perdait sa ligne.
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        <ModelPicker items={avail} value={cur.id} onChange={setEng} disabled={disabled}
          className="min-w-0 flex-1"
          itemExtra={(id) => {
            const e = avail.find((x) => x.id === id);
            return e && isNC(e) ? <Badge variant="outline" className="text-[10px]">NC</Badge> : null;
          }} />
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon" className="shrink-0"
            disabled={disabled || (!s.tracked && !s.points.length)} onClick={() => s.testRefine(cur.id)}
            aria-label={t("matte.test")}>
            <FlaskConical className="h-4 w-4" />
          </Button>} />
          <TooltipContent>{t("matte.test")} — {t("matte.testTip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" className="shrink-0"
            disabled={disabled || !s.outputReady} onClick={() => s.refine(cur.id)} aria-label={t("matte.run")}>
            <Sparkles className="h-4 w-4" />
          </Button>} />
          <TooltipContent>{t("matte.run")} — {cur.hint}</TooltipContent>
        </Tooltip>
      </div>

      {s.refined && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-2 py-1.5">
          <ParamLabel text={t("matte.useRefined")} hint={t("matte.useRefinedTip")} />
          <Toggle size="sm" variant="outline" pressed={s.useRefined} disabled={disabled}
            onPressedChange={(on) => void s.toggleRefined(on)} aria-label={t("matte.useRefined")}>
            {t(s.useRefined ? "remove.on" : "remove.off")}
          </Toggle>
        </div>
      )}

      <AdvancedRows label={t("matte.advanced")}>
        <div className="space-y-1">
          <div className="text-[11px] text-muted-foreground">
            <ParamLabel text={t("matte.size")} hint={t("matte.sizeTip")} />
          </div>
          <ToggleGroup value={[String(p.maxSize)]} disabled={disabled}
            onValueChange={(v) => {
              const picked = Array.isArray(v) ? v[0] : v;
              if (picked != null) set({ maxSize: Number(picked) });
            }}>
            {MATTE_SIZE_STEPS.map((step) => (
              <ToggleGroupItem key={step.value} value={String(step.value)} className="flex-1 text-[11px]">
                {t(step.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {/* Les deux familles de moteur ne se règlent PAS pareil : un moteur à mémoire s'amorce
            (stabilisation), un moteur par lots découpe le plan (lot + recouvrement). Afficher les
            deux jeux laisserait croire que celui de l'autre famille agit. */}
        {batched ? (
          <>
            {slider("matte.batch", p.batch, 4, 48, (n) => set({ batch: n }))}
            {slider("matte.overlap", p.overlap, 0, 8, (n) => set({ overlap: n }))}
          </>
        ) : slider("matte.warmup", p.warmup, 0, 20, (n) => set({ warmup: n }))}
        {s.objects.length > 1 && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <ParamLabel text={t("matte.combined")} hint={t("matte.combinedTip")} />
            <Toggle size="sm" variant="outline" pressed={p.combined} disabled={disabled}
              onPressedChange={(on) => set({ combined: on })} aria-label={t("matte.combined")}>
              {t(p.combined ? "remove.on" : "remove.off")}
            </Toggle>
          </div>
        )}
        <ResetParams onReset={() => s.setMatteParams(DEFAULT_MATTE_PARAMS)}
          disabled={disabled || isSameParams(p, DEFAULT_MATTE_PARAMS)} />
      </AdvancedRows>
    </div>
  );
}

// Sélecteur de format + portée (tous les objets / un seul) + bouton Exporter.
export function ExportRow({ fmt, onFmtChange, disabled, objects, onExport, formats = EXPORT_FORMATS }: {
  // Format PILOTÉ par le parent : le tiroir « Sortie » l'affiche en résumé quand il est fermé,
  // ce qu'un état local ici ne lui laisserait pas voir.
  fmt: string;
  onFmtChange: (fmt: string) => void;
  disabled: boolean;
  objects: { id: number; name: string }[];
  onExport: (fmt: string, obj?: number) => void;
  // Formats offered for THIS source: video codecs for a clip, image files for a still.
  formats?: { id: string; label: string; hint: string }[];
}) {
  const { t } = useTranslation("roto");
  const fmtKey = EXPORT_FMT_KEY;
  const setFmt = onFmtChange;
  const [scope, setScope] = useState(0);   // 0 = union (tous les objets)
  const cur = formats.find((f) => f.id === fmt) || formats[0];
  const scopeItems = [{ value: "0", label: t("exportRow.allObjects") },
    ...objects.map((o) => ({ value: String(o.id), label: o.name }))];
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Select value={cur.id} onValueChange={(v) => setFmt(String(v))}
          items={formats.map((f) => ({ value: f.id, label: t(`exportFmt.${fmtKey[f.id]}Label`, { defaultValue: f.label }) }))} disabled={disabled}>
          <SelectTrigger className="min-w-0 flex-1"><SelectValue>{t(`exportFmt.${fmtKey[cur.id]}Label`, { defaultValue: cur.label })}</SelectValue></SelectTrigger>
          <SelectContent>
            {formats.map((f) => <SelectItem key={f.id} value={f.id}>{t(`exportFmt.${fmtKey[f.id]}Label`, { defaultValue: f.label })}</SelectItem>)}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon" disabled={disabled}
            onClick={() => onExport(fmt, scope || undefined)} aria-label={t("exportRow.exportAria")}>
            <Download className="h-4 w-4" />
          </Button>} />
          <TooltipContent>{t(`exportFmt.${fmtKey[cur.id]}Hint`, { defaultValue: cur.hint })}</TooltipContent>
        </Tooltip>
      </div>
      {objects.length > 1 && (
        <Select value={String(scope)} onValueChange={(v) => setScope(Number(v))} items={scopeItems} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue>{scopeItems.find((i) => i.value === String(scope))?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {scopeItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
