// Panneau Paramètres du board (accessible depuis l'accueil et la barre d'outils) : fond du board
// (points/uni + couleur, déplacés depuis la barre d'outils), enregistrement auto (activer +
// intervalle), et la liste de référence des raccourcis clavier.
//
// NON-MODAL (panneau flottant, sans voile) : le board reste visible et interactif → les réglages
// (couleur/mode de fond) se voient EN DIRECT pendant qu'on les change. Fermeture : croix ou Échap.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Grid2x2, Square, X, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { ColorPicker } from "@/components/ui/color-picker";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { UP_MODELS, UP_SCALES, boardUpEngine } from "@/components/upscale/upscaleShared";
import { ModelsCta } from "@/components/upscale/ModelPicker";
import { useBoard } from "./useReferenceBoard";
import { PinnedBarEditor } from "./PinnedBarEditor";
import { PINNED_SIDES } from "./toolbarButtons";
import {
  SOURCE_FPS, BG_OPACITY_MIN, MEDIA_OPACITY_MIN, clampBgOpacity, clampMediaOpacity,
  type AutoToggle, type BoardPrefs, type BlurBehavior,
} from "./boardPrefs";
import { FLAT_PRESSURE, probeDevices } from "./tabletInput";
import { useBoardUpChoices } from "./useBoardUpChoices";
import { DOWNLOADABLE_EMBED_PROVIDERS, EMBED_LEVELS, EMBED_QUALITIES, EMBED_MARGINS, type EmbedProvider } from "./referenceShared";
import { iconForProvider } from "./brandIcons";
import { Kbd } from "@/components/ui/kbd";
import { ShortcutEditor } from "@/components/shortcuts/ShortcutEditor";
import {
  DRAW_TOOL_DEFS, DEFAULT_DRAW_KEYS,
  SHORTCUT_DEFS, DEFAULT_SHORTCUT_KEYS,
} from "./referenceShared";
import { FontPicker, NumberSpin, MiniSelect, fontLabel } from "./inspectorControls";

const INTERVALS: { label: string; ms: number }[] = [
  { label: "0,5 s", ms: 500 },
  { label: "1 s", ms: 1000 },
  { label: "2 s", ms: 2000 },
  { label: "5 s", ms: 5000 },
  { label: "10 s", ms: 10000 },
];

const ZOOM_SPEEDS: { labelKey: string; v: number }[] = [
  { labelKey: "settings.speedSlow", v: 0.5 },
  { labelKey: "settings.speedNormal", v: 1 },
  { labelKey: "settings.speedFast", v: 1.8 },
];
const DOT_GAPS: { label: string; v: number }[] = [
  { label: "16", v: 16 },
  { label: "24", v: 24 },
  { label: "32", v: 32 },
  { label: "48", v: 48 },
];

// Taille de pose : côté max (px board) d'un média fraîchement posé sur le board.
const MEDIA_SIZES: { labelKey: string; v: number }[] = [
  { labelKey: "settings.sizeS", v: 280 },
  { labelKey: "settings.sizeM", v: 420 },
  { labelKey: "settings.sizeL", v: 640 },
  { labelKey: "settings.sizeXL", v: 900 },
];

// Sort de la barre de l'item sélectionné quand la fenêtre perd le focus (clic dans une autre
// application). Défaut « garder » : la board sert de référence À CÔTÉ de l'outil de travail.
const BLUR_BEHAVIORS: { labelKey: string; v: BlurBehavior }[] = [
  { labelKey: "settings.blurKeep", v: "keep" },
  { labelKey: "settings.blurHide", v: "hide" },
  { labelKey: "settings.blurDeselect", v: "deselect" },
];

// Remplissage par défaut des nouveaux cadres (mêmes 3 modes que l'inspecteur de cadre).
const FRAME_FILLS: { labelKey: string; v: "none" | "tint" | "solid" }[] = [
  { labelKey: "settings.fillNone", v: "none" },
  { labelKey: "settings.fillTint", v: "tint" },
  { labelKey: "settings.fillSolid", v: "solid" },
];

// Onglets du panneau (les 13 sections en liste plate rendaient le panneau interminable).
type SettingsTab = "look" | "media" | "behavior" | "pen" | "keys";
const TABS: { id: SettingsTab; labelKey: string }[] = [
  { id: "look", labelKey: "settings.tabLook" },
  { id: "media", labelKey: "settings.tabMedia" },
  { id: "behavior", labelKey: "settings.tabBehavior" },
  { id: "pen", labelKey: "settings.tabPen" },
  { id: "keys", labelKey: "settings.tabKeys" },
];

// Réglages « auto / activé / désactivé » : `auto` laisse la sonde matérielle trancher, les deux
// autres l'écrasent. Trois machines très différentes partagent cet onglet, aucune valeur fixe ne
// leur convient à toutes.
const AUTO_MODES: { labelKey: string; v: AutoToggle }[] = [
  { labelKey: "settings.auto", v: "auto" },
  { labelKey: "settings.enabled", v: "on" },
  { labelKey: "settings.disabled", v: "off" },
];

// Épaisseur restante à pression nulle, en part de l'épaisseur nominale. 100 % = aucun effet de
// pression sur la largeur (le tracé garde alors la variation d'inclinaison si elle est active).
const PEN_MIN_WIDTHS = [0.1, 0.25, 0.35, 0.5, 0.7, 1];

// Réglages d'extraction de séquence (vidéo → frames d'aperçu). SOURCE_FPS = cadence de la vidéo.
const SEQ_FPS = [SOURCE_FPS, 8, 12, 24];
const SEQ_FPS_MIN = 1;
const SEQ_FPS_MAX = 120;
const SEQ_QUALITY: { labelKey: string; v: number }[] = [
  { labelKey: "settings.qualityLow", v: 144 },
  { labelKey: "settings.qualityMed", v: 240 },
  { labelKey: "settings.qualityHigh", v: 360 },
  { labelKey: "settings.qualityMax", v: 480 },
];
const SEQ_MAX = [60, 150, 300, 600];
const SEQ_MARGIN: { label: string; v: number }[] = [
  { label: "0", v: 0 },
  { label: "0,5 s", v: 0.5 },
  { label: "1 s", v: 1 },
  { label: "2 s", v: 2 },
];

// Bouton segment (choix exclusif) à la DA shadcn, sans dépendance ToggleGroup ici.
function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // bordure TOUJOURS présente (transparente si active) → la largeur ne change pas au clic
        // (sinon les éléments voisins sautaient de 2px à chaque bascule).
        "inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-medium transition-colors",
        active ? "border-transparent bg-primary text-primary-foreground" : "border-border bg-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Ce que la machine déclare, en direct. Sans lui, un utilisateur dont la pression ne fait rien n'a
 * aucun moyen de savoir si le réglage est coupé, si son pilote n'expose pas de capteur (Windows Ink
 * désactivé côté Wacom → la spec impose alors 0,5 constant) ou si son matériel n'en a pas.
 * L'écoute est posée sur la FENÊTRE : survoler le panneau suffit à renseigner la ligne, sans avoir
 * à tracer quoi que ce soit.
 */
function PenProbe() {
  const { t } = useTranslation("reference");
  const [live, setLive] = useState<{ pressure: number; tilt: number } | null>(null);
  const [seen, setSeen] = useState(() => probeDevices().penSeen);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "pen") return;
      setSeen(true);
      // Un stylet émet à plusieurs centaines de hertz : un setState par événement rendrait le
      // panneau à la même cadence pour un chiffre qui bouge de 0,01.
      if (frame.current != null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        setLive({ pressure: e.pressure, tilt: Math.round(Math.hypot(e.tiltX, e.tiltY)) });
      });
    };
    window.addEventListener("pointermove", onMove, { capture: true, passive: true });
    window.addEventListener("pointerdown", onMove, { capture: true, passive: true });
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      window.removeEventListener("pointermove", onMove, { capture: true });
      window.removeEventListener("pointerdown", onMove, { capture: true });
    };
  }, []);

  const d = probeDevices();
  const yes = t("settings.penYes"), no = t("settings.penNo");
  // Une pression FIGÉE sur la valeur de la spec veut dire « pas de capteur », pas « pression nulle ».
  const pressure = !live ? "—"
    : Math.abs(live.pressure - FLAT_PRESSURE) < 0.01 ? t("settings.penNoSensor")
      : `${Math.round(live.pressure * 100)} %`;
  const rows: [string, string][] = [
    [t("settings.penProbePen"), seen ? yes : no],
    [t("settings.penProbePressure"), pressure],
    [t("settings.penProbeTilt"), live ? `${live.tilt}°` : "—"],
    [t("settings.penProbeHover"), d.anyHover ? yes : no],
    [t("settings.penProbeTouch"), String(d.touchPoints)],
  ];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-foreground">{t("settings.penProbe")}</h3>
      <p className="-mt-1 text-[11px] leading-snug text-muted-foreground">{t("settings.penProbeHint")}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="col-span-2 flex items-center justify-between gap-3 sm:col-span-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xs text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
export function BoardSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation("reference");
  // Raccourcis INHÉRENTS (non rebindables : gestes souris/molette, event navigateur, directionnels).
  const FIXED_SHORTCUTS: { keys: string[]; desc: string }[] = [
    { keys: ["Ctrl", "V"], desc: t("settings.gesturePaste") },
    { keys: [t("settings.keyArrows")], desc: t("settings.gestureMove") },
    { keys: [t("settings.keySpace"), t("settings.keyDrag")], desc: t("settings.gestureNavigate") },
    { keys: [t("settings.keyWheel")], desc: t("settings.gestureZoom") },
    { keys: [t("settings.keyBgDrag")], desc: t("settings.gestureMarquee") },
    { keys: [t("settings.keyShift"), t("settings.keyStroke")], desc: t("settings.gestureConstrain") },
    { keys: [t("settings.keyEsc")], desc: t("settings.gestureExitDraw") },
  ];
  const background = useBoard((s) => s.background);
  const setBackground = useBoard((s) => s.setBackground);
  const placeFrame = useBoard((s) => s.placeFrame);
  const setPlaceFrame = useBoard((s) => s.setPlaceFrame);
  const save = useBoard((s) => s.save);
  const setSave = useBoard((s) => s.setSave);
  const prefs = useBoard((s) => s.prefs);
  const setPrefs = useBoard((s) => s.setPrefs);
  const toggleFavFont = useBoard((s) => s.toggleFavFont);
  // Valeur courante du sélecteur unifié « Modèle » (id du modèle IA OU du shader Turbo).
  const upDefault = prefs.upEngine === "turbo" ? prefs.upShader : prefs.upModel;
  const { ready: modelsReady, choices: upChoices } = useBoardUpChoices("any");
  useEffect(() => {
    if (!modelsReady) return; // statut inconnu : ne jamais écraser le modèle choisi par l'utilisateur
    if (upChoices.length && !upChoices.some((choice) => choice.value === upDefault)) {
      const next = upChoices[0];
      setPrefs(next.engine === "turbo" ? { upEngine: "turbo", upShader: next.value as BoardPrefs["upShader"] } : { upEngine: "ia", upModel: next.value as BoardPrefs["upModel"] });
    }
  }, [modelsReady, upChoices, upDefault, setPrefs]);
  // Plateformes du téléchargement auto : réécrites dans l'ordre canonique (l'affichage ne bouge pas
  // quand on coche/décoche).
  const downloadProviders = new Set(prefs.autoDownloadProviders);
  const toggleDownloadProvider = (provider: EmbedProvider) =>
    setPrefs({
      autoDownloadProviders: DOWNLOADABLE_EMBED_PROVIDERS.filter((p) =>
        (p === provider ? !downloadProviders.has(p) : downloadProviders.has(p))),
    });
  const [tab, setTab] = useState<SettingsTab>("look");

  // Réaffectation d'un raccourci d'OUTIL de dessin : `capturing` = l'outil en attente d'une lettre.
  // La prochaine frappe l'affecte (échange si déjà prise) ; Échap annule. Écouteur en phase de
  // CAPTURE → passe avant l'Échap qui ferme le panneau, et `stopImmediatePropagation` empêche la
  // frappe de déclencher une action du board pendant la capture.
  // Les raccourcis-COMMANDES ont leur propre capture dans `ShortcutEditor` (règle différente : un
  // combo, pas une lettre) ; `cmdCapturing` la remonte ici pour l'interlock Échap ci-dessous.
  const [capturing, setCapturing] = useState<string | null>(null);
  const [cmdCapturing, setCmdCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      // Modificateur seul (Ctrl/Shift/…) → on attend le reste du combo, sans consommer la frappe.
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") { setCapturing(null); return; }
      const k = e.key.toLowerCase();
      if (!/^[a-z0-9]$/.test(k)) return; // une seule lettre/chiffre pour un outil
      const cur = prefs.drawKeys;
      const next = { ...cur, [capturing]: k };
      const owner = Object.keys(cur).find((t) => cur[t] === k && t !== capturing);
      if (owner) next[owner] = cur[capturing]; // échange → jamais deux outils sur la même touche
      setPrefs({ drawKeys: next });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, prefs.drawKeys, setPrefs]);

  // Échap ferme (sans voler les autres raccourcis du board quand fermé). Pendant la capture d'un
  // raccourci — outil OU commande — Échap annule la capture (géré ailleurs) et ne ferme PAS le panneau.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !capturing && !cmdCapturing) { e.stopPropagation(); onOpenChange(false); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange, capturing, cmdCapturing]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label={t("actions.settings")}
      className="absolute right-3 top-14 z-50 flex max-h-[calc(100%-4.5rem)] w-96 flex-col overflow-y-auto rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t("actions.settings")}</h2>
        <button type="button" aria-label={t("common:action.close")} onClick={() => onOpenChange(false)} className="inline-flex items-center justify-center size-6 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      {/* Onglets : regroupent les sections (la liste plate était interminable) */}
      <div className="flex items-center gap-1.5 border-b border-border px-4 py-2">
        {TABS.map((tb) => (
          <Seg key={tb.id} active={tab === tb.id} onClick={() => setTab(tb.id)}>{t(tb.labelKey)}</Seg>
        ))}
      </div>

      <div className="flex flex-col gap-5 p-4">
        {tab === "look" && (<>
        {/* Fond du board */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.background")}</h3>
          <div className="flex items-center gap-2">
            <Seg active={background.mode === "dots"} onClick={() => setBackground({ mode: "dots" })}>
              <Grid2x2 className="size-3.5" /> {t("settings.dots")}
            </Seg>
            <Seg active={background.mode === "solid"} onClick={() => setBackground({ mode: "solid" })}>
              <Square className="size-3.5" /> {t("settings.solid")}
            </Seg>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("settings.color")}</span>
              <ColorPicker value={background.color} onChange={(c) => setBackground({ color: c })} ariaLabel={t("settings.bgColor")} side="bottom" />
            </div>
          </div>
          {background.mode === "dots" && (
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">{t("settings.spacing")}</span>
              {DOT_GAPS.map((g) => (
                <Seg key={g.v} active={prefs.dotGap === g.v} onClick={() => setPrefs({ dotGap: g.v })}>{g.label}</Seg>
              ))}
            </div>
          )}
          {/* Background opacity alone: media stay opaque. */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">{t("settings.bgOpacity")}</span>
            <Slider
              aria-label={t("settings.bgOpacity")}
              value={[Math.round(background.opacity * 100)]}
              min={Math.round(BG_OPACITY_MIN * 100)}
              max={100}
              step={1}
              onValueChange={(v) => setBackground({ opacity: clampBgOpacity((Array.isArray(v) ? v[0] : v) / 100) })}
            />
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round(background.opacity * 100)} %
            </span>
          </div>
          {/* CONTENT opacity: media, notes, frames, strokes. Alt+wheel sets it too — over the
              void for the whole board, over a medium for that one alone. */}
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs text-muted-foreground">{t("settings.contentOpacity")}</span>
            <Slider
              aria-label={t("settings.contentOpacity")}
              value={[Math.round(prefs.contentOpacity * 100)]}
              min={Math.round(MEDIA_OPACITY_MIN * 100)}
              max={100}
              step={1}
              onValueChange={(v) => setPrefs({ contentOpacity: clampMediaOpacity((Array.isArray(v) ? v[0] : v) / 100) })}
            />
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {Math.round(prefs.contentOpacity * 100)} %
            </span>
          </div>
          {/* Scope of the translucency: what it reaches beyond the background itself. */}
          {background.opacity < 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">{t("settings.seeThroughScope")}</span>
              <Seg active={prefs.seeThroughShell} onClick={() => setPrefs({ seeThroughShell: !prefs.seeThroughShell })}>
                {t("settings.seeThroughShell")}
              </Seg>
              <Seg active={prefs.seeThroughPlaceFrame} onClick={() => setPrefs({ seeThroughPlaceFrame: !prefs.seeThroughPlaceFrame })}>
                {t("settings.seeThroughPlaceFrame")}
              </Seg>
            </div>
          )}
        </section>

        <Separator />

        {/* Nouvelles notes : valeurs par défaut appliquées à chaque note ajoutée */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.newNotes")}</h3>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.defaultFont")}</span>
            <FontPicker value={prefs.defaultFont} onChange={(v) => setPrefs({ defaultFont: v })} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.defaultSize")}</span>
            <NumberSpin value={prefs.defaultFontSize} ariaLabel={t("settings.defaultSize")} onCommit={(v) => setPrefs({ defaultFontSize: v })} />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.textColor")}</span>
            <ColorPicker value={prefs.defaultTextColor} onChange={(c) => setPrefs({ defaultTextColor: c })} ariaLabel={t("settings.defaultTextColor")} side="bottom" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.noteBg")}</span>
            <ColorPicker value={prefs.defaultNoteBg} onChange={(c) => setPrefs({ defaultNoteBg: c })} ariaLabel={t("settings.defaultNoteBg")} allowTransparent side="bottom" />
          </div>
        </section>

        <Separator />

        {/* Nouveaux cadres : défauts appliqués à chaque cadre ajouté (cohérent avec les notes) */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.newFrames")}</h3>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.frameColor")}</span>
            <ColorPicker value={prefs.defaultFrameColor} onChange={(c) => setPrefs({ defaultFrameColor: c })} ariaLabel={t("settings.frameColor")} side="bottom" />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">{t("settings.frameFill")}</span>
            <div className="flex items-center gap-1.5">
              {FRAME_FILLS.map((f) => (
                <Seg key={f.v} active={prefs.defaultFrameFill === f.v} onClick={() => setPrefs({ defaultFrameFill: f.v })}>{t(f.labelKey)}</Seg>
              ))}
            </div>
          </div>
        </section>

        <Separator />

        {/* Polices favorites : épinglées en tête du sélecteur (étoile dans le sélecteur de police) */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.favFonts")}</h3>
          {prefs.favFonts.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("settings.favHintBefore")}<Star className="inline size-3 -mt-0.5" />{t("settings.favHintAfter")}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {prefs.favFonts.map((f) => (
                <Tooltip key={f}>
                  <TooltipTrigger
                    render={
                      <button type="button"
                        onClick={() => toggleFavFont(f)}
                        aria-label={t("actions.removeFavorite")}
                        className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-1 text-xs text-foreground transition-colors hover:border-destructive/60"
                        style={{ fontFamily: f }}
                      />
                    }
                  >
                    <Star className="size-3 shrink-0 fill-current text-primary" />
                    <span className="truncate">{fontLabel(f, t)}</span>
                    <X className="size-3 shrink-0 text-muted-foreground group-hover:text-destructive" />
                  </TooltipTrigger>
                  <TooltipContent>{t("actions.removeFavorite")}</TooltipContent>
                </Tooltip>
              ))}
            </div>
          )}
        </section>
        </>)}

        {tab === "behavior" && (<>
        {/* Navigation : zoom molette */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.navigation")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.invertWheel")}</span>
            <Seg active={prefs.invertZoom} onClick={() => setPrefs({ invertZoom: !prefs.invertZoom })}>
              {prefs.invertZoom ? t("settings.inverted") : t("settings.normal")}
            </Seg>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">{t("settings.speed")}</span>
            {ZOOM_SPEEDS.map((z) => (
              <Seg key={z.v} active={prefs.zoomSpeed === z.v} onClick={() => setPrefs({ zoomSpeed: z.v })}>{t(z.labelKey)}</Seg>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.mediaDuringNavigation")}</span>
            <Seg
              active={prefs.pauseMediaWhileNavigating}
              onClick={() => setPrefs({ pauseMediaWhileNavigating: !prefs.pauseMediaWhileNavigating })}
            >
              {prefs.pauseMediaWhileNavigating ? t("settings.pauseMedia") : t("settings.keepPlaying")}
            </Seg>
          </div>
        </section>

        <Separator />

        {/* Aimant : accrochage d'un item déplacé sur les bords, centres et coins des voisins. */}
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.snapTitle")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.snapEnabled")}</span>
            <Seg active={prefs.snap} onClick={() => setPrefs({ snap: !prefs.snap })}>
              {prefs.snap ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">{t("settings.snapThreshold")}</span>
            {[4, 8, 14, 20].map((v) => (
              <Seg key={v} active={prefs.snapThreshold === v} onClick={() => setPrefs({ snapThreshold: v })}>{v}</Seg>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">{t("settings.snapStick")}</span>
            {[0, 4, 8, 16].map((v) => (
              <Seg key={v} active={prefs.snapStick === v} onClick={() => setPrefs({ snapStick: v })}>{v}</Seg>
            ))}
          </div>
        </section>

        <Separator />

        {/* Rangement de groupe + accrochage des tracés + palette */}
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.arrangeTitle")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.autoArrangeOnImport")}</span>
            <Seg active={prefs.autoArrangeOnImport} onClick={() => setPrefs({ autoArrangeOnImport: !prefs.autoArrangeOnImport })}>
              {prefs.autoArrangeOnImport ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.autoAnchorDraw")}</span>
            <Seg active={prefs.autoAnchorDraw} onClick={() => setPrefs({ autoAnchorDraw: !prefs.autoAnchorDraw })}>
              {prefs.autoAnchorDraw ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">{t("settings.paletteSize")}</span>
            {[4, 6, 8, 12].map((v) => (
              <Seg key={v} active={prefs.paletteSize === v} onClick={() => setPrefs({ paletteSize: v })}>{v}</Seg>
            ))}
          </div>
        </section>

        <Separator />

        {/* Barre de l'item sélectionné quand l'application passe en arrière-plan */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.blurBehavior")}</h3>
          <p className="text-[11px] text-muted-foreground">{t("settings.blurBehaviorHint")}</p>
          <div className="flex items-center gap-1.5">
            {BLUR_BEHAVIORS.map((b) => (
              <Seg key={b.v} active={prefs.blurBehavior === b.v} onClick={() => setPrefs({ blurBehavior: b.v })}>
                {t(b.labelKey)}
              </Seg>
            ))}
          </div>
        </section>

        <Separator />

        {/* Comportement */}
        <section className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.fitOnOpen")}</h3>
          <Seg active={prefs.fitOnOpen} onClick={() => setPrefs({ fitOnOpen: !prefs.fitOnOpen })}>
            {prefs.fitOnOpen ? t("settings.enabled") : t("settings.disabled")}
          </Seg>
        </section>

        <Separator />

        {/* Cadre « zone de pose » : contour englobant le contenu (médias + dessins) */}
        <section className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.placeFrame")}</h3>
          <Seg active={placeFrame} onClick={() => setPlaceFrame(!placeFrame)}>
            {placeFrame ? t("settings.enabled") : t("settings.disabled")}
          </Seg>
        </section>

        <Separator />

        {/* Normal-window toolbar: same editor as the pinned bar. */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.barButtons")}</h3>
          <PinnedBarEditor
            side="top"
            start={prefs.barButtons}
            end={prefs.barButtonsEnd}
            onChange={(next) => setPrefs({ barButtons: next.start, barButtonsEnd: next.end })}
          />
        </section>

        <Separator />

        {/* Fenêtre épinglée : barre d'outils réduite, ou planche entièrement nue */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.pinnedToolbar")}</h3>
            <Seg active={prefs.pinnedToolbar} onClick={() => setPrefs({ pinnedToolbar: !prefs.pinnedToolbar })}>
              {prefs.pinnedToolbar ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("settings.pinnedToolbarHint")}</p>
          {prefs.pinnedToolbar && (<>
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">{t("settings.pinnedSide")}</span>
              {PINNED_SIDES.map((s) => (
                <Seg key={s.id} active={prefs.pinnedSide === s.id} onClick={() => setPrefs({ pinnedSide: s.id })}>
                  {t(s.labelKey)}
                </Seg>
              ))}
            </div>
            {/* Bar content, laid out by dragging onto a mockup of the bar itself. Pin, detach and
                reattach are not in it: they are the ways out of the format, and they stay put
                whatever else is removed. */}
            <span className="text-xs text-muted-foreground">{t("settings.pinnedButtons")}</span>
            <PinnedBarEditor
              side={prefs.pinnedSide}
              start={prefs.pinnedButtons}
              end={prefs.pinnedButtonsEnd}
              onChange={(next) => setPrefs({ pinnedButtons: next.start, pinnedButtonsEnd: next.end })}
            />
          </>)}
        </section>

        <Separator />

        {/* Enregistrement auto */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.autosave")}</h3>
            <Seg active={save.enabled} onClick={() => setSave({ enabled: !save.enabled })}>
              {save.enabled ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className={cn("flex flex-col gap-1.5", !save.enabled && "pointer-events-none opacity-40")}>
            <span className="text-xs text-muted-foreground">{t("settings.interval")}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {INTERVALS.map((i) => (
                <Seg key={i.ms} active={save.ms === i.ms} onClick={() => setSave({ ms: i.ms })}>{i.label}</Seg>
              ))}
            </div>
          </div>
        </section>
        </>)}

        {tab === "pen" && (<>
        {/* Navigation — la partie BLOQUANTE : sans molette ni barre d'espace, une machine tactile
            n'a aucun autre moyen de se déplacer sur la planche. */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.penNav")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penGestures")}</span>
            <Seg active={prefs.touchGestures} onClick={() => setPrefs({ touchGestures: !prefs.touchGestures })}>
              {prefs.touchGestures ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground">{t("settings.penDragPans")}</span>
              <div className="flex items-center gap-1.5">
                {AUTO_MODES.map((m) => (
                  <Seg key={m.v} active={prefs.penDragPans === m.v} onClick={() => setPrefs({ penDragPans: m.v })}>{t(m.labelKey)}</Seg>
                ))}
              </div>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.penDragPansHint")}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penBarrel")}</span>
            <div className="flex items-center gap-1.5">
              <Seg active={prefs.penBarrel === "menu"} onClick={() => setPrefs({ penBarrel: "menu" })}>{t("settings.penBarrelMenu")}</Seg>
              <Seg active={prefs.penBarrel === "pan"} onClick={() => setPrefs({ penBarrel: "pan" })}>{t("settings.penBarrelPan")}</Seg>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground">{t("settings.penPalm")}</span>
              <Seg active={prefs.palmRejection} onClick={() => setPrefs({ palmRejection: !prefs.palmRejection })}>
                {prefs.palmRejection ? t("settings.enabled") : t("settings.disabled")}
              </Seg>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.penPalmHint")}</p>
          </div>
        </section>

        <Separator />

        {/* Tracé : ce qui distingue une tablette d'une souris. */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.penStroke")}</h3>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penPressure")}</span>
            <Seg active={prefs.penPressure} onClick={() => setPrefs({ penPressure: !prefs.penPressure })}>
              {prefs.penPressure ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className={cn("flex flex-col gap-1.5", !prefs.penPressure && "pointer-events-none opacity-40")}>
            <span className="text-xs text-muted-foreground">{t("settings.penMinWidth")}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {PEN_MIN_WIDTHS.map((v) => (
                <Seg key={v} active={prefs.penMinWidth === v} onClick={() => setPrefs({ penMinWidth: v })}>{`${Math.round(v * 100)} %`}</Seg>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penTilt")}</span>
            <Seg active={prefs.penTilt} onClick={() => setPrefs({ penTilt: !prefs.penTilt })}>
              {prefs.penTilt ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penEraser")}</span>
            <Seg active={prefs.penEraserTip} onClick={() => setPrefs({ penEraserTip: !prefs.penEraserTip })}>
              {prefs.penEraserTip ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.penStrokeHint")}</p>
        </section>

        <Separator />

        {/* Interface : une commande qui n'apparaît qu'au survol n'existe pas sur une dalle tactile. */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.penUi")}</h3>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-foreground">{t("settings.penTouchUi")}</span>
              <div className="flex items-center gap-1.5">
                {AUTO_MODES.map((m) => (
                  <Seg key={m.v} active={prefs.touchUi === m.v} onClick={() => setPrefs({ touchUi: m.v })}>{t(m.labelKey)}</Seg>
                ))}
              </div>
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">{t("settings.penTouchUiHint")}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-foreground">{t("settings.penBigTargets")}</span>
            <Seg active={prefs.bigTargets} onClick={() => setPrefs({ bigTargets: !prefs.bigTargets })}>
              {prefs.bigTargets ? t("settings.enabled") : t("settings.disabled")}
            </Seg>
          </div>
        </section>

        <Separator />

        {/* Ce que la machine déclare. Le seul moyen de savoir pourquoi un réglage `auto` a tranché
            comme il l'a fait — et de dire, quand la pression ne fait rien, si c'est le pilote. */}
        <PenProbe />
        </>)}

        {tab === "media" && (<>
        {/* Taille de pose : côté max (px board) d'un média fraîchement posé */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.placeSize")}</h3>
          <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">{t("settings.placeSizeHint")}</p>
          <div className="flex items-center gap-1.5">
            {MEDIA_SIZES.map((s) => (
              <Seg key={s.v} active={prefs.mediaMaxSize === s.v} onClick={() => setPrefs({ mediaMaxSize: s.v })}>{t(s.labelKey)}</Seg>
            ))}
          </div>
        </section>

        <Separator />

        {/* Ce que le fichier .netsu garde des médias, par défaut. Un item peut surcharger ce choix
            depuis son inspecteur — c'est ici qu'on décide pour tous les autres. */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("embed.settings.title")}</h3>
          <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">{t("embed.settings.hint")}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {EMBED_LEVELS.map((lv) => (
              <Seg key={lv} active={prefs.embedLevel === lv} onClick={() => setPrefs({ embedLevel: lv })}>
                {t(`embed.level.${lv}`)}
              </Seg>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-muted-foreground">{t(`embed.hint.${prefs.embedLevel}`)}</p>
          {(prefs.embedLevel === "preview" || prefs.embedLevel === "margin") && (
            <div className="flex items-center gap-1.5">
              <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("embed.quality.label")}</span>
              {EMBED_QUALITIES.map((q) => (
                <Seg key={q} active={prefs.embedQuality === q} onClick={() => setPrefs({ embedQuality: q })}>
                  {t(`embed.quality.${q}`)}
                </Seg>
              ))}
            </div>
          )}
          {prefs.embedLevel === "margin" && (
            <div className="flex items-center gap-1.5">
              <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("embed.margin.label")}</span>
              {EMBED_MARGINS.map((m) => (
                <Seg key={m} active={prefs.embedMargin === m} onClick={() => setPrefs({ embedMargin: m })}>
                  {t("embed.margin.seconds", { count: m })}
                </Seg>
              ))}
            </div>
          )}
        </section>

        <Separator />

        {/* Séquence d'images : réglages de l'extraction vidéo → frames d'aperçu */}
        <section className="flex flex-col gap-2.5">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.decompose")}</h3>
          <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">{t("settings.decomposeHint")}</p>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("settings.imagesPerSec")}</span>
            {SEQ_FPS.map((f) => (
              <Seg key={f} active={prefs.seqFps === f} onClick={() => setPrefs({ seqFps: f })}>
                {f === SOURCE_FPS ? t("settings.sourceFps") : `${f} i/s`}
              </Seg>
            ))}
            {/* Cadence libre : la saisie prime sur les paliers (aucun palier actif tant qu'elle diffère). */}
            <NumberSpin
              value={prefs.seqFps > 0 ? prefs.seqFps : SEQ_FPS_MIN}
              min={SEQ_FPS_MIN} max={SEQ_FPS_MAX}
              ariaLabel={t("settings.customFps")}
              onCommit={(v) => setPrefs({ seqFps: v })}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("settings.quality")}</span>
            {SEQ_QUALITY.map((q) => (
              <Seg key={q.v} active={prefs.seqHeight === q.v} onClick={() => setPrefs({ seqHeight: q.v })}>{t(q.labelKey)}</Seg>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("settings.max")}</span>
            {SEQ_MAX.map((m) => (
              <Seg key={m} active={prefs.seqMaxFrames === m} onClick={() => setPrefs({ seqMaxFrames: m })}>{m}</Seg>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("settings.margin")}</span>
            {SEQ_MARGIN.map((m) => (
              <Seg key={m.v} active={prefs.seqMarginSec === m.v} onClick={() => setPrefs({ seqMarginSec: m.v })}>{m.label}</Seg>
            ))}
          </div>
        </section>

        <Separator />

        {/* Upscale par défaut : pré-remplit la popup d'upscale d'un item média — ou la remplace
            entièrement en mode « rapide » (le bouton Upscale lance avec ces réglages). */}
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.upscaleDefault")}</h3>
            <Seg active={prefs.upQuick} onClick={() => setPrefs({ upQuick: !prefs.upQuick })}>
              {prefs.upQuick ? t("settings.upscaleQuick") : t("settings.upscaleAsk")}
            </Seg>
          </div>
          <p className="-mt-1.5 text-[11px] leading-snug text-muted-foreground">
            {prefs.upQuick ? t("settings.upscaleQuickHint") : t("settings.upscaleAskHint")}
          </p>
          {upChoices.length ? (
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">{t("settings.model")}</span>
              <MiniSelect
                ariaLabel={t("settings.upscaleModelDefault")} className="w-52"
                value={upDefault}
                onChange={(v) => setPrefs(boardUpEngine(v) === "turbo" ? { upEngine: "turbo", upShader: v as BoardPrefs["upShader"] } : { upEngine: "ia", upModel: v as BoardPrefs["upModel"] })}
                items={upChoices.map((c) => ({ value: c.value, label: c.label }))}
              />
            </div>
          ) : (
            <ModelsCta label={t("settings.noModelInstalled")} />
          )}
          <div className="flex items-center gap-1.5">
            <span className="mr-1 w-16 shrink-0 text-xs text-muted-foreground">{t("settings.factor")}</span>
            {UP_SCALES.map((s) => (
              <Seg key={s} active={prefs.upScale === s} onClick={() => setPrefs({ upScale: s })}>{s}×</Seg>
            ))}
          </div>
          {prefs.upEngine === "ia" && UP_MODELS.find((m) => m.id === prefs.upModel)?.denoise && (
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{t("settings.denoise")}</span>
              <Slider
                className="flex-1"
                value={[Math.round(prefs.upDenoise * 100)]}
                min={0} max={100} step={5}
                onValueChange={(v) => setPrefs({ upDenoise: (Array.isArray(v) ? v[0] : v) / 100 })}
              />
              <span className="w-12 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">{Math.round(prefs.upDenoise * 100)} %</span>
            </div>
          )}
        </section>

        <Separator />

        {/* Online media downloads by default; YouTube stays linked. Providers remain individually configurable. */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.downloadOnline")}</h3>
            <Seg active={prefs.autoDownloadOnline} onClick={() => setPrefs({ autoDownloadOnline: !prefs.autoDownloadOnline })}>
              {prefs.autoDownloadOnline ? t("settings.auto") : t("settings.manual")}
            </Seg>
          </div>
          {/* Médias LOCAUX copiés dans le dossier compagnon du projet. Sans ça, un projet ne garde
              qu'un pointeur vers le fichier d'origine : renommé, effacé ou resté sur l'autre machine,
              la case est vide. L'original n'est jamais déplacé — c'est une copie. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("settings.copyLocal")}</span>
            <Seg active={prefs.copyLocalIntoProject} onClick={() => setPrefs({ copyLocalIntoProject: !prefs.copyLocalIntoProject })}>
              {prefs.copyLocalIntoProject ? t("settings.copyLocalOn") : t("settings.copyLocalOff")}
            </Seg>
          </div>
          {/* Le plafond ne vise que les VIDÉOS : une image passe toujours. Il est ce qui rend la copie
              tenable par défaut — un board porte des boucles de quelques Mo, pas des rushes de 12 Go. */}
          {prefs.copyLocalIntoProject && (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">{t("settings.copyLocalMax")}</span>
              <NumberSpin
                value={prefs.copyLocalMaxMB}
                min={0} max={65536} step={64}
                ariaLabel={t("settings.copyLocalMax")}
                onCommit={(v) => setPrefs({ copyLocalMaxMB: v })}
              />
            </div>
          )}
          {/* Repasser un média en lecteur/carte embed : garder le fichier (aller-retour instantané)
              ou le supprimer (disque libéré, prochain retour = nouveau téléchargement). */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{t("settings.embedSwitch")}</span>
            <Seg active={!prefs.dropDownloadOnEmbed} onClick={() => setPrefs({ dropDownloadOnEmbed: !prefs.dropDownloadOnEmbed })}>
              {prefs.dropDownloadOnEmbed ? t("settings.embedSwitchDrop") : t("settings.embedSwitchKeep")}
            </Seg>
          </div>
          {prefs.autoDownloadOnline && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">{t("settings.downloadProviders")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {DOWNLOADABLE_EMBED_PROVIDERS.map((p) => {
                  const Icon = iconForProvider(p);
                  return (
                    <Seg key={p} active={downloadProviders.has(p)} onClick={() => toggleDownloadProvider(p)}>
                      <Icon className="size-3.5" /> {t(`settings.provider_${p}`)}
                    </Seg>
                  );
                })}
              </div>
            </div>
          )}
        </section>
        </>)}

        {tab === "keys" && (<>
        {/* Raccourcis du dessin — MODIFIABLES : clic sur la touche → appuie sur la nouvelle lettre. */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">{t("settings.drawShortcuts")}</h3>
            <button
              type="button"
              onClick={() => { setCapturing(null); setPrefs({ drawKeys: DEFAULT_DRAW_KEYS }); }}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t("common:action.reset")}
            </button>
          </div>
          <ul className="flex flex-col gap-1.5">
            {DRAW_TOOL_DEFS.map((d) => (
              <li key={d.tool} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{t(d.labelKey)}</span>
                <button
                  type="button"
                  aria-label={t("settings.editShortcut", { label: t(d.labelKey) })}
                  onClick={() => setCapturing((c) => (c === d.tool ? null : d.tool))}
                  className={cn(
                    "inline-flex h-6 min-w-[2rem] items-center justify-center rounded border px-2 text-[11px] font-semibold uppercase tabular-nums transition-colors",
                    capturing === d.tool
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border bg-muted text-foreground hover:border-primary/60",
                  )}
                >
                  {capturing === d.tool ? "…" : (prefs.drawKeys[d.tool] || "—")}
                </button>
              </li>
            ))}
          </ul>
          {capturing && <p className="text-[11px] text-muted-foreground">{t("settings.pressLetter")}</p>}
        </section>

        <Separator />

        {/* Raccourcis-commandes — MODIFIABLES : clic sur le combo → appuie sur la nouvelle combinaison. */}
        <ShortcutEditor
          defs={SHORTCUT_DEFS}
          keys={prefs.shortcutKeys}
          onChange={(shortcutKeys) => setPrefs({ shortcutKeys })}
          onReset={() => setPrefs({ shortcutKeys: DEFAULT_SHORTCUT_KEYS })}
          title={t("settings.keyboardShortcuts")}
          onCapturingChange={setCmdCapturing}
        />

        <Separator />

        {/* Gestes / raccourcis inhérents (non modifiables) */}
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-foreground">{t("settings.gestures")}</h3>
          <ul className="flex flex-col gap-1.5">
            {FIXED_SHORTCUTS.map((s, i) => (
              <li key={`${s.keys.join("-")}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{s.desc}</span>
                <span className="flex shrink-0 items-center gap-1">
                  {s.keys.map((k, j) => (
                    <span key={k} className="flex items-center gap-1">
                      {j > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
                      <Kbd>{k}</Kbd>
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
        </>)}
      </div>
    </div>
  );
}
