// Éditeur d'un profil d'export. Layout STABLE : toutes les lignes sont toujours présentes,
// désactivées (grisées) quand elles ne s'appliquent pas au flux choisi → l'UI ne saute jamais
// quand on change de réglage. Moteurs GPU filtrés par sonde réelle côté core. shadcn Base UI.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput, ChevronDown, CircleHelp, TriangleAlert } from "lucide-react";
import { useApp } from "@/store";
import { nr } from "@/lib/bridge";
import { swrRead } from "@/lib/swr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectGroupLabel, SelectItem,
} from "@/components/ui/select";
import { UpscalePane } from "@/components/upscale/UpscalePane";
import { ExportAudioSelect } from "./ExportAudioSelect";
import { ExportNaming } from "./ExportNaming";
import { ExportTimelineTarget } from "./ExportTimelineTarget";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  type ExportProfile,
  type ExportEncoderMode,
  EXPORT_WORKFLOW_OPTIONS,
  EXPORT_AUDIO_OPTIONS,
  EXPORT_CONTAINER_OPTIONS,
  EXPORT_SPEED_OPTIONS,
  getExportCodecLabel,
  usesEncoding,
  usesFile,
  getExportProfileIssue,
  MERGE_GAP_DEFAULT_MS,
} from "@/features/export/profiles";
import { NumberSpin } from "@/components/ui/number-spin";
import { useExportEncodingFields } from "@/features/export/encodingFields";
import { IconPicker } from "./IconPicker";
import {
  BLACK_PAUSE_MAX_SECONDS,
  BLACK_PAUSE_STEP_SECONDS,
  millisecondsToSeconds,
  secondsToMilliseconds,
} from "./blackPause";

function Row({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 transition-opacity", disabled && "opacity-40")}>
      <span className="text-[0.8125rem] text-muted-foreground">{label}</span>
      <div className="w-[56%] shrink-0">{children}</div>
    </div>
  );
}

export function ProfileEditor({ profile }: { profile: ExportProfile }) {
  const { t } = useTranslation("export");
  const update = useApp((s) => s.updateExportProfile);
  const set = (patch: Partial<ExportProfile>) => update(profile.id, patch);

  const encode = usesEncoding(profile.workflow);
  const file = usesFile(profile.workflow);
  const isTimelineImport = profile.workflow === "timeline_import";
  // Le choix de piste vaut pour l'import timeline aussi (l'import n'y répond qu'en tout-ou-rien).
  const audioSettable = file || isTimelineImport;
  // Sans objet si le son est coupé (la ligne Audio au-dessus le dit) ou hors ré-encodage.
  const codecSettable = encode && profile.audioMode !== "none";

  // Moteurs/codecs réellement exécutables ici + cascade de compatibilité : logique partagée avec les
  // réglages du hub et l'archivage d'une collection (features/export/encodingFields).
  const fields = useExportEncodingFields(profile, set);
  const speedSettable = encode && fields.speedSettable;

  // Codec audio : en remux comme en import, ré-encoder le son n'a pas de sens → « Copie » seule.
  const audioOptions = encode ? fields.audioOptions : EXPORT_AUDIO_OPTIONS.filter((o) => o.value === "copy");
  const audioGroups = encode ? fields.audioGroups : [];
  const audioLoneOptions = audioOptions.filter((o) => !audioGroups.some((g) => g.options.includes(o)));
  // Conteneurs proposés : filtrés au codec en ré-encodage (jamais un couple invalide), tous sinon.
  const containerOptions = encode ? fields.containerOptions : EXPORT_CONTAINER_OPTIONS;

  // Ligne « Dossier » : même geste pour les deux mondes, cible différente — dossier du Media Pool
  // en import timeline, sous-dossier de sortie en export fichier.
  const folderField = isTimelineImport ? "binTarget" : "folderTarget";
  const folderValue = isTimelineImport ? profile.binTarget ?? null : profile.folderTarget ?? null;
  const setFolder = (v: string | null) => set({ [folderField]: v });
  const folderHint = t(isTimelineImport ? "editor.folderHint" : "editor.folderHintFile");
  // Réglage obligatoire manquant → champ en rouge (et export bloqué côté bouton).
  const folderIssue = getExportProfileIssue(profile, folderField);
  const folderErrorId = `${profile.id}-folder-error`;

  // Dossiers Media Pool existants (suggestions du sélecteur de destination) : on peut en choisir un
  // OU en saisir un nouveau (créé à la volée côté Resolve). Chargés seulement pour l'import timeline.
  const [bins, setBins] = useState<string[]>([]);
  useEffect(() => {
    if (!isTimelineImport) return;
    let alive = true;
    // SWR : bins du snapshot d'abord (instantané), timelineTree live remplace ensuite.
    void swrRead(
      nr.snapshot?.peek("tree"),
      () => nr.timelineTree(),
      (r) => {
        if (!alive || !r.ok) return;
        const uniq = [...new Set(r.timelines.map((t: { bin: string }) => t.bin).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        setBins(uniq);
      },
    );
    return () => { alive = false; };
  }, [isTimelineImport]);

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] text-muted-foreground">{t("editor.name")}</span>
        <div className="flex items-center gap-2">
          <IconPicker profile={profile} onChange={(icon) => set({ icon })} />
          <Input value={profile.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("editor.namePlaceholder")} className="flex-1" />
        </div>
      </div>

      {/* Rangement, dans les deux mondes : l'import timeline range la timeline créée dans un
          DOSSIER DU MEDIA POOL (au lieu de la racine, où elle se mêlerait aux rushs) ; un export
          fichier range ses fichiers dans un SOUS-DOSSIER du dossier choisi au moment de l'export.
          Même geste, même ligne — d'où le libellé « Dossier » seul, la cible dépend du flux. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            {t("editor.folder")}
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex shrink-0" tabIndex={0} aria-label={folderHint} />}>
                <CircleHelp className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent side="right" align="center" className="max-w-64">{folderHint}</TooltipContent>
            </Tooltip>
          </span>
          {/* `!= null` et pas la véracité : un nom VIDE reste « rangé dans un dossier » (en rouge),
              sinon l'interrupteur retomberait dès qu'on efface le champ pour le retaper. */}
          <Toggle
            pressed={folderValue != null}
            onPressedChange={(p) => setFolder(p ? (folderValue || t("editor.defaultFolder")) : null)}
          >
            {folderValue != null ? t("toggle.yes") : t("toggle.no")}
          </Toggle>
        </div>
        {folderValue != null && (
          <div className="flex items-center gap-1">
            <Input
              value={folderValue}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={t("editor.folderPlaceholder")}
              className={cn("flex-1", folderIssue && "border-destructive focus-visible:ring-destructive/40")}
              aria-invalid={!!folderIssue}
              aria-errormessage={folderIssue ? folderErrorId : undefined}
            />
            {/* Suggestions : seul le Media Pool sait quels dossiers existent déjà. Un sous-dossier
                de sortie est créé à la volée, il n'y a rien à proposer. */}
            {isTimelineImport && bins.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={t("editor.existingFolders")}>
                  <ChevronDown className="size-4" />
                </Button>} />
                <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>{t("editor.mediaPoolFolders")}</DropdownMenuLabel>
                    {bins.map((b) => (
                      <DropdownMenuItem key={b} onClick={() => set({ binTarget: b })}>
                        <FolderInput className="size-3.5" /> {b}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
        {folderIssue && (
          <span id={folderErrorId} className="text-[0.75rem] text-destructive">{folderIssue.message}</span>
        )}
      </div>

      {/* Timeline visée : celle ouverte, une nouvelle, ou une existante par son nom. Même valeur que
          le sélecteur du panneau de droite (elle vit dans le profil). Toujours posée, grisée hors
          import timeline — comme toutes les autres lignes, pour que l'UI ne saute pas. */}
      <div className={cn("flex flex-col gap-1.5 transition-opacity", !isTimelineImport && "opacity-40")}>
        <span className="text-[0.8125rem] text-muted-foreground">{t("editor.timelineTarget")}</span>
        <ExportTimelineTarget profile={profile} className="w-full" disabled={!isTimelineImport} />
      </div>

      {/* Choix du flux APRÈS les réglages propres à la timeline : ce qui suit (moteur, codec,
          conteneur, nommage) vaut pour les trois, la bascule se lit donc comme leur en-tête. */}
      <ToggleGroup
        className="w-full"
        value={[profile.workflow]}
        onValueChange={(v) => {
          const wf = v[0] as ExportProfile["workflow"] | undefined;
          if (!wf) return;
          // Remux/import timeline n'acceptent pas un codec audio ré-encodé → retour à « Copie ».
          // Le son coupé (« none ») survit au changement de flux : c'est un choix de piste, pas de codec.
          const fix = (wf === "video_remux" || wf === "timeline_import") && profile.audioMode !== "copy" && profile.audioMode !== "none"
            ? { audioMode: "copy" as const } : {};
          set({ workflow: wf, ...fix });
        }}
      >
        {EXPORT_WORKFLOW_OPTIONS.map((o) => (
          <ToggleGroupItem
            key={o.value}
            className="flex-1 gap-1 text-xs"
            value={o.value}
            // Le Remux copie le flux : la coupe se cale sur les images clés de la source, donc
            // quelques images en trop en tête et en queue. Signalé SUR l'option elle-même — le
            // compromis se lit au moment où l'on choisit le flux, sans bloc qui pousse la suite.
            aria-label={o.value === "video_remux" ? `${o.label} — ${t("workflow.remuxWarning")}` : undefined}
          >
            {o.label}
            {o.value === "video_remux" && (
              <Tooltip>
                {/* Non focusable : le bouton porteur l'est déjà et annonce l'avertissement. */}
                <TooltipTrigger render={<span className="inline-flex shrink-0 text-amber-500" aria-hidden="true" />}>
                  <TriangleAlert className="size-3" />
                </TooltipTrigger>
                <TooltipContent side="bottom" align="center" className="max-w-72">{t("workflow.remuxWarningDetail")}</TooltipContent>
              </Tooltip>
            )}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Agrandir les plans PENDANT l'export. Mêmes contrôles que le panneau Traitements et que
          l'archivage d'une collection — c'est le même composant, aucune copie. Hors ré-encodage le
          volet DISPARAÎT au lieu d'être grisé : l'upscale remplace les pixels, une copie de flux ne
          peut pas le faire, et c'est un bloc repliable, pas une ligne de réglage à largeur fixe
          (même règle que le gabarit de nommage). Le réglage lui-même survit au changement de flux. */}
      {encode && (
        <UpscalePane
          value={profile.upscale}
          onChange={(patch) => set({ upscale: { ...profile.upscale, ...patch } })}
          label={t("editor.upscale")}
          onLabel={t("toggle.yes")}
          offLabel={t("toggle.no")}
        />
      )}

      <Row label={t("editor.optimization")} disabled={!encode}>
        <Select
          value={fields.encoderMode}
          onValueChange={(value) => fields.pickEncoderMode(value as ExportEncoderMode)}
          items={fields.encoderItems}
          disabled={!encode}
        >
          <SelectTrigger>
            <SelectValue>{fields.encoderItems.find((item) => item.value === fields.encoderMode)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {fields.encoderItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>

      <Row label={t("editor.speed")} disabled={!speedSettable}>
        <Select
          value={fields.speed}
          onValueChange={(value) => set({ speed: value as ExportProfile["speed"] })}
          items={EXPORT_SPEED_OPTIONS}
          disabled={!speedSettable}
        >
          <SelectTrigger><SelectValue>{EXPORT_SPEED_OPTIONS.find((option) => option.value === fields.speed)?.label}</SelectValue></SelectTrigger>
          <SelectContent>
            {EXPORT_SPEED_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label={t("editor.codec")} disabled={!encode}>
        <Select
          value={profile.codec}
          // Cale le conteneur sur un choix compatible (ex. AV1 refuse MOV) → jamais de couple invalide,
          // puis le codec audio sur le conteneur retenu (WebM → Opus).
          onValueChange={(v) => fields.pickCodec(v as ExportProfile["codec"])}
          items={fields.codecOptions}
          disabled={!encode}
        >
          <SelectTrigger><SelectValue>{getExportCodecLabel(profile.codec)}</SelectValue></SelectTrigger>
          <SelectContent>
            {fields.codecGroups.map((g) => (
              <SelectGroup key={g.key}>
                <SelectGroupLabel>{g.label}</SelectGroupLabel>
                {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Row>

      {/* QUELLE audio sortir : toutes les pistes, aucune, une piste précise ou la piste d'une langue
          (tags normalisés + secours IA si non étiquetée). Menu partagé avec le panneau du derush. */}
      <Row label={t("editor.audio")} disabled={!audioSettable}>
        <ExportAudioSelect profile={profile} />
      </Row>

      {/* COMMENT l'encoder. « Aucun » n'est plus ici : couper le son se dit dans la ligne au-dessus. */}
      <Row label={t("editor.audioCodec")} disabled={!codecSettable}>
        {/* Son coupé → la ligne est grisée : on y montre le 1er codec offert par le conteneur, jamais
            « Copie » en dur (le WebM ne l'offre pas → le champ serait vide). */}
        <Select
          value={profile.audioMode === "none" ? (audioOptions[0]?.value ?? "copy") : profile.audioMode}
          onValueChange={(v) => set({ audioMode: v as ExportProfile["audioMode"] })}
          items={audioOptions}
          disabled={!codecSettable}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {audioLoneOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
            {audioGroups.map((g) => (
              <SelectGroup key={g.family}>
                <SelectGroupLabel>{g.label}</SelectGroupLabel>
                {g.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </Row>

      <Row label={t("editor.container")} disabled={!file}>
        <Select
          value={profile.container}
          onValueChange={(v) => fields.pickContainer(v as ExportProfile["container"])}
          items={containerOptions}
          disabled={!file}
        >
          <SelectTrigger><SelectValue>{profile.container.toUpperCase()}</SelectValue></SelectTrigger>
          <SelectContent>
            {containerOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Row>

      {/* Nom des fichiers produits. Hors flux fichier il n'y a aucun fichier à nommer (l'import
          timeline ne sort rien) → le bloc disparaît au lieu d'être grisé : c'est un champ libre avec
          son aperçu, pas une ligne de réglage à largeur fixe. */}
      {file && <ExportNaming profile={profile} onChange={(naming) => set({ naming })} />}

      <Row label={t("editor.mergeToOne")} disabled={!file}>
        <div className="flex justify-end">
          <Toggle pressed={profile.mergeEnabled} onPressedChange={(p) => set({ mergeEnabled: p })} disabled={!file}>
            {profile.mergeEnabled ? t("toggle.yes") : t("toggle.no")}
          </Toggle>
        </div>
      </Row>

      {/* Noir intercalé entre les plans du montage fusionné : bout à bout, deux plans consécutifs se
          touchent à l'image près et rien ne marque la coupe à l'œil. Sans fusion la ligne n'a pas
          d'objet (chaque plan est déjà un fichier), mais elle reste EN PLACE, grisée — le panneau ne
          doit pas se réagencer quand on bascule un interrupteur. */}
      <Row label={t("editor.mergeGap")} disabled={!file || !profile.mergeEnabled}>
        <div className="flex items-center justify-end gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <NumberSpin
                value={millisecondsToSeconds(profile.mergeGap ?? MERGE_GAP_DEFAULT_MS)}
                min={0}
                max={BLACK_PAUSE_MAX_SECONDS}
                step={BLACK_PAUSE_STEP_SECONDS}
                ariaLabel={t("editor.mergeGap")}
                disabled={!file || !profile.mergeEnabled}
                onCommit={(v) => set({ mergeGap: secondsToMilliseconds(v) })}
              />
            </TooltipTrigger>
            <TooltipContent side="left">{t("editor.mergeGapHint")}</TooltipContent>
          </Tooltip>
          <span className="text-[0.75rem] text-muted-foreground">{t("editor.seconds")}</span>
        </div>
      </Row>
    </div>
  );
}
