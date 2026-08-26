// Création / édition d'un dossier de collection. Fenêtre PRINCIPALE compacte (icône + nom + couleur +
// description + groupes + dossier parent) + boutons ouvrant de PETITES fenêtres dédiées, UNE à la fois
// (icône, médias, archivage) → la page ne se surcharge jamais. L'icône a 3 onglets façon Carnet/Export.
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { LucideIcon } from "lucide-react";
import { ImagePlus, Smile, Shapes, Images as ImagesIcon, Search, X, FolderInput, HardDrive, RefreshCw, FileWarning, Link2, Tags, ChevronRight } from "lucide-react";
import { lucideIcon, lucideNames, useLucideCatalog } from "@/lib/lucideCatalog";
import { useApp } from "@/store";
import { Spinner } from "@/components/ui/spinner";
import { nr, type CollectionIcon, type CollectionMeta, type CollectionArchive, type CollectionArchiveUpscale, type OfflineMedia } from "@/lib/bridge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ColorPicker } from "@/components/ui/color-picker";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EmojiPicker } from "@/components/common/EmojiPicker";
import { TagInput } from "./TagInput";
import {
  EXPORT_AUDIO_OPTIONS, EXPORT_CONTAINER_OPTIONS, EXPORT_SPEED_OPTIONS, getExportCodecLabel,
  coerceExportCodec, coerceExportContainer, coerceExportAudioMode, coerceAudioSelect,
  coerceExportEncoderMode, coerceExportSpeed, usesFile,
  AUDIO_LANGUAGES, AUDIO_TRACK_SLOTS, audioSelectValue, parseAudioSelectValue, audioSelectLabel,
  type ExportCodec, type ExportContainer, type ExportAudioMode, type ExportEncoderMode,
  type ExportProfile, type ExportSpeed, type AudioSelect,
} from "@/features/export/profiles";
import { useExportEncodingFields } from "@/features/export/encodingFields";
import { HintLabel } from "@/components/upscale/procSettingsParts";
import { ArchivePane, ArchiveRow, ArchiveUpscaleRows, ArchiveUpscaleSummary, ArchiveUpscaleToggle } from "./archiveRows";
import { folderTrail } from "./collectionShared";
import { CollectionGlyph, DEFAULT_COLLECTION_COLOR } from "./collectionGlyph";
import { cn } from "@/lib/utils";

const ROOT = "__root__";
// Côté de la vignette du dossier, aligné sur la hauteur du champ de nom à côté.
const GLYPH_SIZE = 44;
// Valeur du sélecteur de profil quand les réglages d'archivage ne correspondent à aucun profil.
const CUSTOM_ARCHIVE_PROFILE = "__custom__";
type Tab = "emoji" | "icon" | "image";
type Sub = "" | "icon" | "media" | "archive";   // petite fenêtre ouverte (une seule à la fois)

function IconTab({ current, onPick }: { current: string | null; onPick: (icon: CollectionIcon) => void }) {
  const { t } = useTranslation("collections");
  // Grille du jeu COMPLET : le catalogue arrive dans un chunk asynchrone (cf. lib/lucideCatalog).
  useLucideCatalog();
  const names = lucideNames();
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? names.filter((n) => n.toLowerCase().includes(s)) : names).slice(0, 240);
  }, [q, names]);
  return (
    <div className="flex flex-col">
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-muted px-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("editor.iconSearch")} className="w-full bg-transparent py-1.5 text-sm outline-none focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      </div>
      <div className="grid max-h-64 grid-cols-9 gap-1 overflow-y-auto">
        {list.map((n) => (
          <Tooltip key={n}>
            <TooltipTrigger render={
              <button type="button" onClick={() => onPick({ kind: "lucide", name: n })}
                className={cn("flex aspect-square items-center justify-center rounded-md transition-colors",
                  current === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
                {createElement(lucideIcon(n) as LucideIcon, { className: "h-4 w-4" })}
              </button>
            } />
            <TooltipContent>{n}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

// Rangée d'identité (Groupes, Dossier) : colonne de libellé à largeur FIXE — sans elle, les deux
// rangées n'alignent pas leurs contrôles et les icônes se compriment.
function FieldRow({ icon, label, hint, children }: {
  icon: React.ReactNode; label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-2 flex w-[5.5rem] shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        <HintLabel label={label} hint={hint} className="truncate" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// En-tête de sous-réglage (déplie une section EN PLACE, pas de nouvelle fenêtre) : icône + libellé à
// gauche, statut à droite, chevron qui pivote quand ouvert.
function SettingRow({ icon, label, hint, open, onClick }: { icon: React.ReactNode; label: string; hint?: React.ReactNode; open: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open}
      className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50">
      <span className="text-muted-foreground">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint}
      <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
    </button>
  );
}

export function FolderEditor({
  open, onOpenChange, editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: CollectionMeta | null;   // null/undefined = création
}) {
  const { t: tr } = useTranslation(["collections", "common"]);
  // Libellés partagés avec l'éditeur de profil d'export (mêmes réglages, mêmes mots).
  const { t: te } = useTranslation("export");
  const { createCollection, updateCollection, relocateArchive, folders, collectionTags, loadCollectionTags, loadCollectionFolders, exportProfiles } = useApp(
    useShallow((s) => ({
      createCollection: s.createCollection, updateCollection: s.updateCollection,
      relocateArchive: s.relocateArchive,
      folders: s.collectionFolders, collectionTags: s.collectionTags,
      loadCollectionTags: s.loadCollectionTags, loadCollectionFolders: s.loadCollectionFolders,
      exportProfiles: s.exportProfiles,
    })),
  );

  const [sub, setSub] = useState<Sub>("");         // fenêtre ICÔNE (picker lourd → reste une fenêtre)
  const [expanded, setExpanded] = useState<"" | "media" | "archive">("");   // section dépliée EN PLACE
  const [pane, setPane] = useState<"" | "video" | "upscale">("");           // volet d'archivage ouvert (un seul)
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(DEFAULT_COLLECTION_COLOR);
  const [icon, setIcon] = useState<CollectionIcon | null>(null);
  const [tab, setTab] = useState<Tab>("emoji");
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Organisation + archivage
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [archiveOn, setArchiveOn] = useState(false);
  const [archiveDir, setArchiveDir] = useState("");
  const [archiveWorkflow, setArchiveWorkflow] = useState<"video_remux" | "video_encode">("video_remux");
  const [archiveCodec, setArchiveCodec] = useState<ExportCodec>("h264_high");
  const [archiveEncoder, setArchiveEncoder] = useState<ExportEncoderMode>("gpu");
  const [archiveSpeed, setArchiveSpeed] = useState<ExportSpeed>("balanced");
  const [archiveContainer, setArchiveContainer] = useState<ExportContainer>("mp4");
  const [archiveAudio, setArchiveAudio] = useState<ExportAudioMode>("copy");
  const [archiveAudioSel, setArchiveAudioSel] = useState<AudioSelect>({ mode: "auto" });
  const [autoSync, setAutoSync] = useState(false);
  const [upscale, setUpscale] = useState<CollectionArchiveUpscale>({});
  const [relocating, setRelocating] = useState(false);
  const [moveErr, setMoveErr] = useState<string | null>(null);
  const prevArchive = useRef<CollectionArchive | null>(null);
  // Médias hors-ligne (sources manquantes) — relier par fichier ou dossier de renvoi.
  const [offline, setOffline] = useState<OfflineMedia[]>([]);
  const [checkingOffline, setCheckingOffline] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  // Réglages d'encodage de l'archive : EXACTEMENT les mêmes contrôles et garde-fous que l'éditeur de
  // profil d'export (moteur sondé, vitesse, codec, codec audio filtré par le conteneur) — l'archivage
  // écrit des fichiers avec le même moteur, il n'y a aucune raison qu'il propose autre chose.
  const encoding = useExportEncodingFields(
    { codec: archiveCodec, container: archiveContainer, audioMode: archiveAudio, encoderMode: archiveEncoder, speed: archiveSpeed },
    (patch) => {
      if (patch.codec) setArchiveCodec(patch.codec);
      if (patch.container) setArchiveContainer(patch.container);
      if (patch.audioMode) setArchiveAudio(patch.audioMode);
      if (patch.encoderMode) setArchiveEncoder(patch.encoderMode);
      if (patch.speed) setArchiveSpeed(patch.speed);
    },
  );
  // Agrandir remplace les pixels : la copie de flux ne peut pas le faire. L'upscale actif IMPOSE donc
  // le ré-encodage (le core applique la même règle) — Remux est grisé plutôt que silencieusement ignoré.
  const upscaling = !!upscale.enabled;
  const reencode = archiveWorkflow === "video_encode" || upscaling;

  // Un profil d'export enregistré remplit tous les réglages d'un coup — même palette que le bouton
  // Télécharger. Les profils « timeline » sont écartés : l'archivage écrit des fichiers.
  const fileProfiles = exportProfiles.filter((profile) => usesFile(profile.workflow));
  const matchedProfile = fileProfiles.find((profile) => profile.workflow === archiveWorkflow
    && profile.container === archiveContainer && profile.audioMode === archiveAudio
    && (!reencode || (profile.codec === archiveCodec
      && coerceExportEncoderMode(profile.encoderMode) === archiveEncoder
      && coerceExportSpeed(profile.speed) === archiveSpeed)));
  const applyProfile = (profile: ExportProfile) => {
    setArchiveWorkflow(profile.workflow === "video_encode" ? "video_encode" : "video_remux");
    setArchiveCodec(profile.codec);
    setArchiveEncoder(coerceExportEncoderMode(profile.encoderMode));
    setArchiveSpeed(coerceExportSpeed(profile.speed));
    setArchiveContainer(profile.container);
    setArchiveAudio(profile.audioMode);
    setArchiveAudioSel(coerceAudioSelect(profile.audioSelect));
  };
  const archiveContainers = reencode ? encoding.containerOptions : EXPORT_CONTAINER_OPTIONS;
  // En copie de flux, ré-encoder le son n'a pas de sens : « Copie » ou rien.
  const archiveAudioOptions = reencode ? encoding.audioLoneOptions : EXPORT_AUDIO_OPTIONS.filter((o) => o.value === "copy");
  const archiveAudioGroups = reencode ? encoding.audioGroups : [];
  // Dossier de stockage pointé sur une autre cible alors que des fichiers sont déjà écrits → l'archive
  // déménage à l'enregistrement (le dossier n'est jamais figé).
  const archivedDir = editing?.archive?.lastAt ? (editing.archive.dir || "") : "";
  const dirChanged = archiveOn && !!archivedDir && !!archiveDir.trim() && archivedDir !== archiveDir.trim();

  // Réinitialise les champs à l'ouverture selon le dossier édité (ou défauts en création).
  useEffect(() => {
    if (!open) return;
    setSub(""); setExpanded(""); setPane("");
    void loadCollectionTags();
    void loadCollectionFolders();
    setName(editing?.name ?? "");
    setColor(editing?.color ?? DEFAULT_COLLECTION_COLOR);
    const ic = editing?.icon ?? { kind: "lucide" as const, name: "folder" };
    setIcon(ic);
    setTab(ic.kind === "image" ? "image" : ic.kind === "lucide" ? "icon" : "emoji");
    setDescription(editing?.description ?? "");
    setTags(editing?.collTags ?? []);
    setFolderId(editing?.folderId ?? null);
    const arch = editing?.archive ?? null;
    prevArchive.current = arch;
    setArchiveOn(!!(arch && arch.dir));
    setArchiveDir(arch?.dir ?? "");
    setArchiveWorkflow(arch?.workflow === "video_encode" ? "video_encode" : "video_remux");
    setArchiveCodec(coerceExportCodec(arch?.codec));
    setArchiveEncoder(coerceExportEncoderMode(arch?.encoderMode));
    setArchiveSpeed(coerceExportSpeed(arch?.speed));
    setArchiveContainer(coerceExportContainer(arch?.container));
    setArchiveAudio(coerceExportAudioMode(arch?.audioMode));
    setArchiveAudioSel(coerceAudioSelect(arch?.audioSelect));
    setAutoSync(!!arch?.autoSync);
    setUpscale(arch?.upscale ?? {});
    setMoveErr(null);
    setOffline([]);
    void checkOffline(editing?.id);
    // Déps sur l'IDENTITÉ du dossier édité (id), PAS l'objet `editing` (le parent recalcule `meta` neuf
    // chaque render → boucle si on dépend de l'objet). L'id est stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  async function pickArchiveDir() {
    const d = await nr.chooseDir();
    if (d) { setArchiveDir(d); setArchiveOn(true); }
  }

  async function checkOffline(cid?: string) {
    const cid2 = cid ?? editing?.id;
    if (!cid2) { setOffline([]); return; }
    setCheckingOffline(true);
    const r = await nr.collections?.offline(cid2);
    setCheckingOffline(false);
    setOffline(r?.ok ? (r.missing ?? []) : []);
  }
  async function resyncDir() {
    if (!editing?.id) return;
    const d = await nr.chooseDir();
    if (!d) return;
    setResyncing(true);
    await nr.collections?.relinkDir(editing.id, d);
    setResyncing(false);
    await checkOffline();
  }
  async function relinkOne(oldPath: string) {
    if (!editing?.id) return;
    const p = await nr.chooseFiles();
    if (!p || !p[0]) return;
    await nr.collections?.relinkPath(editing.id, oldPath, p[0]);
    await checkOffline();
  }

  async function uploadIcon(file: File) {
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const ext = (file.name.split(".").pop() || "png").toLowerCase();
      const r = await nr.collections?.saveIcon(buf, ext);
      if (r?.ok && r.path) setIcon({ kind: "image", path: r.path });
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    const n = name.trim();
    if (!n) return;
    const dir = archiveDir.trim();
    const prev = prevArchive.current;
    const settings = {
      workflow: upscaling ? ("video_encode" as const) : archiveWorkflow,
      codec: archiveCodec, encoderMode: archiveEncoder, speed: archiveSpeed,
      container: archiveContainer, audioMode: archiveAudio, audioSelect: archiveAudioSel, autoSync,
      upscale: upscale.enabled ? upscale : undefined,
    };
    setSaving(true); setMoveErr(null);
    // Sur un changement de dossier, on enregistre en gardant l'ANCIEN : c'est la migration qui inscrit
    // le nouveau, une fois les fichiers arrivés. Si elle échoue, l'archive pointe donc toujours là où
    // les fichiers sont réellement. `files` est écrit par le core (quel fichier pour quel plan) — le
    // patch le reconduit, sinon l'enregistrement le perdrait et la migration ne saurait plus quoi déplacer.
    const archive: CollectionArchive | null = archiveOn && dir
      ? { ...settings, dir: dirChanged ? archivedDir : dir, lastAt: prev?.lastAt, files: prev?.files }
      : null;
    const patch = { name: n, color, icon, description: description.trim(), tags, folderId, archive };
    try {
      if (editing) await updateCollection({ id: editing.id, ...patch });
      else await createCollection(patch);
      if (editing && dirChanged) {
        setRelocating(true);
        const r = await relocateArchive(editing.id, { dir, archive: { ...settings, dir } });
        if (!r.ok) { setMoveErr(r.error || tr("editor.moveFailed")); return; }
      }
      onOpenChange(false);
    } finally { setRelocating(false); setSaving(false); }
  }

  const currentLucide = icon?.kind === "lucide" ? icon.name : null;
  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: "emoji", label: tr("editor.tabEmoji"), icon: Smile },
    { id: "icon", label: tr("editor.tabIcon"), icon: Shapes },
    { id: "image", label: tr("editor.tabImage"), icon: ImagesIcon },
  ];

  return (
    <>
      {/* Fenêtre PRINCIPALE — masquée dès qu'une petite fenêtre s'ouvre (ferme celle du dessus). */}
      <Dialog open={open && !sub} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
        {/* La fenêtre ne dépasse JAMAIS l'écran : le corps défile, l'entête et les boutons restent. */}
        <DialogContent className="grid-rows-[auto_1fr_auto] gap-4 sm:max-w-md max-h-[calc(100dvh-3rem)]">
          <DialogHeader>
            <DialogTitle>{editing ? tr("folder.editTitle") : tr("folder.new")}</DialogTitle>
          </DialogHeader>

          {/* `overflow-y-auto` rogne sur les QUATRE côtés (l'autre axe passe à `auto`). Sans marge
              intérieure, le contenu est collé aux bords et tout ce qui déborde de sa boîte — contour
              de la vignette, anneau de focus d'un champ — était coupé net : en haut pour le champ de
              nom, qui est le premier enfant. On ouvre 4 px sur le pourtour et on les reprend en marge
              négative : rien ne bouge à l'écran. */}
          <div className="-m-1 min-h-0 space-y-4 overflow-y-auto overflow-x-hidden p-1">
          <div className="flex items-center gap-3">
            {/* Le contour est dessiné DANS la vignette (`outline` à décalage négatif) et non par une
                boîte parente : une bordure aurait mangé 1 px de la vignette (box-sizing) et un
                `ring` sur un parent aurait son propre rayon, jamais exactement celui de l'image. */}
            <button type="button" onClick={() => setSub("icon")} aria-label={tr("editor.changeIcon")}
              className="group shrink-0 outline-none">
              <CollectionGlyph icon={icon} color={color} size={GLYPH_SIZE}
                className="block outline outline-1 -outline-offset-1 outline-border transition-[outline-color] group-hover:outline-primary group-focus-visible:outline-primary" />
            </button>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void save(); }}
              placeholder={tr("folder.namePlaceholder")} className="h-11 flex-1" />
            <ColorPicker value={color} onChange={setColor} ariaLabel={tr("editor.folderColor")} side="bottom" className="size-11 shrink-0" />
          </div>

          {/* Champs d'identité — repliés dès qu'un sous-réglage est déplié (la section archive
              déroule beaucoup d'options → sinon la fenêtre déborde la page en petit format). */}
          {!expanded && (
            <>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
                placeholder={tr("editor.descPlaceholder")} className="text-xs" />
              {/* Deux rangements DISTINCTS : Groupes = étiquettes multiples (filtres), Dossier =
                  emplacement unique. Icônes + légendes différentes pour lever la confusion. */}
              <FieldRow icon={<Tags className="size-4 shrink-0" />} label={tr("editor.groups")}>
                <TagInput value={tags} onChange={setTags} suggestions={collectionTags} placeholder={tr("editor.groupTag")} />
              </FieldRow>
              <FieldRow icon={<FolderInput className="size-4 shrink-0" />} label={tr("editor.folder")} hint={tr("editor.folderHint")}>
                <div>
                  <Select value={folderId ?? ROOT} onValueChange={(v) => setFolderId(v === ROOT ? null : (v as string))}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue>
                        {(v: string) => (v === ROOT ? tr("folder.root") : folderTrail(folders, v).map((x) => x.name).join(" / ") || tr("folder.root"))}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ROOT}>{tr("folder.root")}</SelectItem>
                      {folders.map((f) => (
                        <SelectItem key={f.id} value={f.id}>{folderTrail(folders, f.id).map((x) => x.name).join(" / ")}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </FieldRow>
            </>
          )}

          {/* Sous-réglages : chacun se DÉPLIE en place (accordéon), la fenêtre s'agrandit. */}
          <div className="space-y-2 border-t border-border pt-3">
            {editing?.id && (
              <div className="overflow-hidden rounded-lg border border-border bg-card">
                <SettingRow icon={<FileWarning className="size-4" />} label={tr("editor.media")} open={expanded === "media"}
                  onClick={() => setExpanded((e) => (e === "media" ? "" : "media"))}
                  hint={offline.length > 0
                    ? <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">{tr("editor.offlineCount", { count: offline.length })}</span>
                    : <span className="text-[11px] text-muted-foreground">{tr("editor.online")}</span>} />
                {expanded === "media" && (
                  <div className="space-y-2 border-t border-border px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <HintLabel label={tr("editor.relinkMoved")} hint={tr("editor.resyncHint")}
                        className="min-w-0 truncate text-xs text-muted-foreground" />
                      <Button variant="outline" size="sm" className="shrink-0" onClick={resyncDir} disabled={resyncing}>
                        {resyncing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} {tr("editor.resync")}
                      </Button>
                    </div>
                    {/* Rien à afficher quand tout est en ligne : l'état est déjà dans l'en-tête de la
                        section. Seules les sources INTROUVABLES demandent une action. */}
                    {!checkingOffline && offline.length > 0 && (
                      <div className="space-y-1">
                        <div className="max-h-48 space-y-1 overflow-y-auto">
                          {offline.map((m) => (
                            <div key={m.path} className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1">
                              <Tooltip>
                                <TooltipTrigger render={<span className="min-w-0 flex-1 truncate text-[11px]">{m.name} <span className="text-muted-foreground">{tr("editor.dotPlans", { count: m.count })}</span></span>} />
                                <TooltipContent>{m.path}</TooltipContent>
                              </Tooltip>
                              <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => relinkOne(m.path)}><Link2 className="size-3" /> {tr("editor.relink")}</Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {/* En-tête archive : le toggle Activé/Désactivé vit DANS la barre (haut-droite), à côté
                  du chevron — hors du bouton d'ouverture (pas de bouton imbriqué). */}
              <div className="flex items-center pr-3">
                <button type="button" aria-expanded={expanded === "archive"}
                  onClick={() => setExpanded((e) => (e === "archive" ? "" : "archive"))}
                  className="flex flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50">
                  <span className="text-muted-foreground"><HardDrive className="size-4" /></span>
                  <span className="flex-1">{tr("archive.onDisk")}</span>
                </button>
                <Toggle size="sm" variant="outline" pressed={archiveOn} onPressedChange={setArchiveOn}
                  className="mr-2.5 shrink-0 text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
                  {archiveOn ? tr("editor.on") : tr("editor.off")}
                </Toggle>
                <button type="button" aria-label={tr("archive.onDisk")} aria-expanded={expanded === "archive"}
                  onClick={() => setExpanded((e) => (e === "archive" ? "" : "archive"))}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
                  <ChevronRight className={cn("size-4 transition-transform", expanded === "archive" && "rotate-90")} />
                </button>
              </div>
              {expanded === "archive" && (
                <div className="space-y-2.5 border-t border-border px-3 py-3">
                  {archiveOn && (
                    <div className="space-y-2.5">
                      <div className="flex items-center gap-2">
                        <Input value={archiveDir} onChange={(e) => setArchiveDir(e.target.value)} placeholder={tr("editor.storagePlaceholder")} className="h-8 flex-1 text-xs" />
                        <Button variant="outline" size="sm" onClick={pickArchiveDir}>{tr("editor.browse")}</Button>
                      </div>
                      {dirChanged && <p className="text-[10px] text-muted-foreground">{tr("editor.moveHint")}</p>}
                      {moveErr && <p className="text-[10px] text-destructive">{moveErr}</p>}
                      {fileProfiles.length > 0 && (
                        <ArchiveRow label={te("editor.profile")}>
                          <Select value={matchedProfile?.id ?? CUSTOM_ARCHIVE_PROFILE}
                            onValueChange={(v) => { const p = fileProfiles.find((x) => x.id === v); if (p) applyProfile(p); }}>
                            <SelectTrigger size="sm" className="flex-1">
                              <SelectValue>{matchedProfile?.name ?? te("editor.profileCustom")}</SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                              {!matchedProfile && <SelectItem value={CUSTOM_ARCHIVE_PROFILE}>{te("editor.profileCustom")}</SelectItem>}
                              {fileProfiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </ArchiveRow>
                      )}
                      {/* Deux volets EXCLUSIFS : ouvrir l'un referme l'autre. Tout déplié, la fenêtre
                          dépassait l'écran. Le résumé à droite dit ce que porte le volet fermé. */}
                      <ArchivePane label={tr("archive.videoFormat")} open={pane === "video"}
                        summary={pane === "video" ? null : `${reencode ? getExportCodecLabel(archiveCodec) : tr("editor.remux")} · ${archiveContainer.toUpperCase()}`}
                        onToggle={() => setPane((p) => (p === "video" ? "" : "video"))}>
                      <Tooltip>
                        <TooltipTrigger render={<div className="w-full" />}>
                          <ToggleGroup className="w-full" value={[reencode ? "video_encode" : archiveWorkflow]}
                            onValueChange={(v) => {
                              const w = v[0];
                              if (w !== "video_remux" && w !== "video_encode") return;
                              if (w === "video_remux" && upscaling) return; // agrandir exige d'encoder
                              setArchiveWorkflow(w);
                              // Passer au ré-encodage réaligne conteneur et codec audio sur le codec vidéo ;
                              // revenir en copie de flux impose « Copie » (seul choix offert, sinon le champ
                              // afficherait un codec absent de sa propre liste).
                              if (w === "video_encode") encoding.pickCodec(archiveCodec);
                              else setArchiveAudio("copy");
                            }}>
                            <ToggleGroupItem value="video_remux" className="flex-1 text-xs" disabled={upscaling}>{tr("editor.remux")}</ToggleGroupItem>
                            <ToggleGroupItem value="video_encode" className="flex-1 text-xs">{tr("editor.reencode")}</ToggleGroupItem>
                          </ToggleGroup>
                        </TooltipTrigger>
                        {upscaling && <TooltipContent>{tr("archive.upscaleNeedsEncode")}</TooltipContent>}
                      </Tooltip>
                      {reencode && (
                        <>
                          <ArchiveRow label={te("editor.optimization")}>
                            <Select value={encoding.encoderMode} onValueChange={(v) => encoding.pickEncoderMode(v as ExportEncoderMode)}>
                              <SelectTrigger size="sm" className="flex-1">
                                <SelectValue>{encoding.encoderItems.find((item) => item.value === encoding.encoderMode)?.label}</SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {encoding.encoderItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </ArchiveRow>
                          <ArchiveRow label={te("editor.speed")}>
                            <Select value={encoding.speed} disabled={!encoding.speedSettable}
                              onValueChange={(v) => setArchiveSpeed(v as ExportSpeed)}>
                              <SelectTrigger size="sm" className="flex-1">
                                <SelectValue>{EXPORT_SPEED_OPTIONS.find((o) => o.value === encoding.speed)?.label}</SelectValue>
                              </SelectTrigger>
                              <SelectContent>
                                {EXPORT_SPEED_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </ArchiveRow>
                          <ArchiveRow label={tr("editor.codec")}>
                            <Select value={archiveCodec} onValueChange={(v) => encoding.pickCodec(v as ExportCodec)}>
                              <SelectTrigger size="sm" className="flex-1"><SelectValue>{getExportCodecLabel(archiveCodec)}</SelectValue></SelectTrigger>
                              <SelectContent className="max-h-72">
                                {encoding.codecGroups.map((g) => (
                                  <SelectGroup key={g.key}>
                                    <SelectGroupLabel>{g.label}</SelectGroupLabel>
                                    {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                                  </SelectGroup>
                                ))}
                              </SelectContent>
                            </Select>
                          </ArchiveRow>
                        </>
                      )}
                      <ArchiveRow label={tr("editor.container")}>
                        <Select value={archiveContainer} onValueChange={(v) => encoding.pickContainer(v as ExportContainer)}>
                          <SelectTrigger size="sm" className="flex-1"><SelectValue>{archiveContainer.toUpperCase()}</SelectValue></SelectTrigger>
                          <SelectContent>
                            {archiveContainers.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </ArchiveRow>
                      <ArchiveRow label={te("editor.audioCodec")}>
                        <Select value={archiveAudio} onValueChange={(v) => setArchiveAudio(v as ExportAudioMode)}>
                          <SelectTrigger size="sm" className="flex-1"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {archiveAudioOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                            {archiveAudioGroups.map((g) => (
                              <SelectGroup key={g.family}>
                                <SelectGroupLabel>{g.label}</SelectGroupLabel>
                                {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </ArchiveRow>
                      {/* Piste audio à garder (VO / VF sur fichiers multi-pistes) : toutes les pistes ;
                          une langue = la piste de cette langue (tags + secours IA) ; Piste N = par numéro. */}
                      {archiveAudio !== "none" && (
                        <ArchiveRow label={tr("editor.track")}>
                          {/* L'upscale passe par le moteur de traitement, qui ne sait pas choisir une
                              piste par LANGUE (il prend la piste par numéro) → le choix est neutralisé
                              plutôt que silencieusement ignoré. */}
                          <Tooltip>
                            <TooltipTrigger render={<div className="flex-1" />}>
                              <Select value={audioSelectValue(archiveAudioSel)} disabled={upscaling}
                                onValueChange={(v) => v && setArchiveAudioSel(coerceAudioSelect(parseAudioSelectValue(v as string)))}>
                                <SelectTrigger size="sm" className="w-full"><SelectValue>{audioSelectLabel(archiveAudioSel)}</SelectValue></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="auto">{tr("editor.trackAll")}</SelectItem>
                                  <SelectGroup>
                                    <SelectGroupLabel>{tr("editor.language")}</SelectGroupLabel>
                                    {AUDIO_LANGUAGES.map((l) => <SelectItem key={l.code} value={`lang:${l.code}`}>{l.label}</SelectItem>)}
                                  </SelectGroup>
                                  <SelectGroup>
                                    <SelectGroupLabel>{tr("editor.track")}</SelectGroupLabel>
                                    {Array.from({ length: AUDIO_TRACK_SLOTS }, (_, i) => <SelectItem key={i} value={`track:${i}`}>{tr("editor.trackN", { n: i + 1 })}</SelectItem>)}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </TooltipTrigger>
                            {upscaling && <TooltipContent>{tr("archive.upscaleAudioNote")}</TooltipContent>}
                          </Tooltip>
                        </ArchiveRow>
                      )}
                      </ArchivePane>

                      <ArchivePane open={pane === "upscale"}
                        label={
                          <Tooltip>
                            <TooltipTrigger render={<span />}>{tr("archive.upscaleShort")}</TooltipTrigger>
                            <TooltipContent>{tr("archive.upscaleHint")}</TooltipContent>
                          </Tooltip>
                        }
                        summary={pane === "upscale" ? null : <ArchiveUpscaleSummary value={upscale} />}
                        control={<ArchiveUpscaleToggle value={upscale} onChange={(patch) => setUpscale((u) => ({ ...u, ...patch }))} />}
                        onToggle={() => setPane((p) => (p === "upscale" ? "" : "upscale"))}>
                        <ArchiveUpscaleRows value={upscale} onChange={(patch) => setUpscale((u) => ({ ...u, ...patch }))} />
                      </ArchivePane>
                      <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/50">
                        <HintLabel label={tr("editor.autoSyncLabel")} hint={tr("editor.autoSyncHint")}
                          className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" />
                        <Toggle size="sm" variant="outline" pressed={autoSync} onPressedChange={setAutoSync}
                          className="shrink-0 text-xs aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
                          {autoSync ? tr("editor.on") : tr("editor.off")}
                        </Toggle>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{tr("common:action.cancel")}</Button>
            <Button onClick={save} disabled={!name.trim() || saving}>
              {saving && <Spinner className="size-4" />}
              {relocating ? tr("editor.moving") : editing ? tr("common:action.save") : tr("editor.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Petite fenêtre — ICÔNE */}
      <Dialog open={sub === "icon"} onOpenChange={(v) => { if (!v) setSub(""); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{tr("editor.iconTitle")}</DialogTitle></DialogHeader>
          <div className="mb-1 flex items-center gap-1 border-b border-border pb-2">
            {tabs.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)}
                className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-sm", tab === t.id ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {createElement(t.icon, { className: "h-3.5 w-3.5" })} {t.label}
              </button>
            ))}
          </div>
          {tab === "emoji" && <EmojiPicker onPick={(ch) => setIcon({ kind: "emoji", ch })} />}
          {tab === "icon" && <IconTab current={currentLucide} onPick={setIcon} />}
          {tab === "image" && (
            <div className="space-y-2">
              {icon?.kind === "image" && (
                <div className="flex items-center gap-2">
                  <CollectionGlyph icon={icon} color={color} size={40} />
                  <button type="button" onClick={() => setIcon({ kind: "lucide", name: "folder" })}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-destructive">
                    <X className="h-3.5 w-3.5" /> {tr("common:action.remove")}
                  </button>
                </div>
              )}
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {uploading ? <Spinner className="size-3.5" /> : <ImagePlus className="h-3.5 w-3.5" />}
                {tr("editor.importImage")}
              </button>
              <input ref={fileRef} type="file" accept="image/*" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadIcon(f); e.target.value = ""; }} />
            </div>
          )}
          <DialogFooter><Button onClick={() => setSub("")}>{tr("common:status.ok")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
