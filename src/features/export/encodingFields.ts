// Logique PARTAGÉE des champs d'encodage (moteur, vitesse, codec, codec audio, conteneur).
//
// Trois écrans posent exactement les mêmes questions dans des mises en page différentes : l'éditeur de
// profil d'export, les réglages du hub NetsuLab et l'archivage d'une collection. Ce qui doit rester
// identique n'est pas le rendu mais les GARDE-FOUS : moteurs réellement sondés, codecs exécutables par
// ce moteur, conteneur compatible du codec, codec audio compatible du conteneur — et la cascade qui
// réaligne le tout quand on change un maillon. Dupliquée, cette cascade divergeait au premier oubli
// (l'archivage proposait FLAC en MP4, que ffmpeg refuse).
//
// Le codec audio, lui, ENTRAÎNE le conteneur au lieu d'être filtré par lui. Filtrer cachait le
// sans-perte : PCM 16/24 bits ne se muxe qu'en MOV/MKV, donc en MP4 le groupe « Sans perte »
// disparaissait du menu et le codec passait pour absent du produit. Le codec vidéo tire déjà le
// conteneur derrière lui (`alignedTo`) ; l'audio suit la même règle.
//
// Le rendu reste à l'appelant : ce module ne connaît ni composant ni classe CSS.
import { useEffect } from "react";
import i18n from "@/i18n";
import {
  EXPORT_AUDIO_OPTIONS,
  coerceExportEncoderMode,
  coerceExportSpeed,
  compatibleContainersForExportCodec,
  codecsForFamily,
  getCodecFamily,
  getCodecFamilyLabel,
  getExportCodecProfileLabel,
  getRecommendedAudioForContainer,
  getRecommendedContainerForCodec,
  groupAudioOptions,
  isExportAudioContainerCompatible,
  isExportCodecContainerCompatible,
  supportsExportSpeed,
  type ExportAudioMode,
  type ExportCodec,
  type ExportCodecFamily,
  type ExportContainer,
  type ExportEncoderMode,
  type ExportSpeed,
} from "./profiles";
import {
  encoderModeForCodec,
  fallbackCodecForEncoder,
  supportedCodecFamilies,
  supportedCodecGroups,
  supportedCodecOptionsForEncoder,
  supportedEncoderModes,
  useExportCapabilities,
} from "./capabilities";

export interface ExportEncodingValue {
  codec: ExportCodec;
  container: ExportContainer;
  audioMode: ExportAudioMode;
  encoderMode?: ExportEncoderMode;
  speed?: ExportSpeed;
}

type Option<T> = { value: T; label: string };

export interface ExportEncodingFields {
  encoderMode: ExportEncoderMode;
  speed: ExportSpeed;
  encoderItems: Option<ExportEncoderMode>[];
  codecOptions: Option<ExportCodec>[];
  codecGroups: { key: string; label: string; options: Option<ExportCodec>[] }[];
  /** Ligne « Codec » : la FAMILLE (H.264, ProRes…). */
  codecFamily: ExportCodecFamily;
  codecFamilyOptions: Option<ExportCodecFamily>[];
  pickCodecFamily: (family: ExportCodecFamily) => void;
  /** Ligne « Profil » : les variantes de la famille choisie (Main 10 bits, 422 HQ…). */
  codecProfileOptions: Option<ExportCodec>[];
  containerOptions: Option<ExportContainer>[];
  audioOptions: Option<ExportAudioMode>[];
  /** Codecs audio hors famille (« Copie ») — à rendre avant les groupes. */
  audioLoneOptions: Option<ExportAudioMode>[];
  audioGroups: { family: string; label: string; options: Option<ExportAudioMode>[] }[];
  pickAudio: (audioMode: ExportAudioMode) => void;
  /** Faux pour les codecs à débit fixe (ProRes, DNxHR, CineForm, FFV1) : le curseur n'a aucun effet. */
  speedSettable: boolean;
  pickEncoderMode: (mode: ExportEncoderMode) => void;
  pickCodec: (codec: ExportCodec) => void;
  pickContainer: (container: ExportContainer) => void;
}

function encoderLabel(mode: ExportEncoderMode): string {
  return i18n.t(`export:encoder.${mode}`);
}

export function useExportEncodingFields(
  value: ExportEncodingValue,
  apply: (patch: Partial<ExportEncodingValue>) => void,
  options: {
    allowedCodecs?: ReadonlySet<ExportCodec>;
    /** Conteneurs que l'écran s'autorise (transfert NLE : MOV/MP4). Absent = tous. */
    allowedContainers?: ReadonlySet<ExportContainer>;
  } = {},
): ExportEncodingFields {
  const caps = useExportCapabilities();
  const { allowedCodecs, allowedContainers } = options;
  const encoderMode = coerceExportEncoderMode(value.encoderMode);
  const speed = coerceExportSpeed(value.speed);

  const codecAllowed = (codec: ExportCodec) => !allowedCodecs || allowedCodecs.has(codec);
  const optionsForMode = (mode: ExportEncoderMode) =>
    supportedCodecOptionsForEncoder(caps, mode).filter((option) => codecAllowed(option.value));
  // Tant que la sonde n'a pas répondu, `optionsForMode` est vide hors CPU : filtrer là-dessus
  // n'afficherait que le CPU pendant quelques secondes, puis ferait sauter la liste.
  const availableEncoderModes = supportedEncoderModes(caps)
    .filter((mode) => !caps.codecs || optionsForMode(mode).length > 0);
  const encoderModes = availableEncoderModes.includes(encoderMode)
    ? availableEncoderModes
    : [encoderMode, ...availableEncoderModes];

  // Conteneur et codec audio doivent suivre le codec vidéo : on renvoie le patch COMPLET plutôt que
  // trois écritures successives (l'appelant peut porter un état local, un rendu intermédiaire
  // incohérent y serait visible).
  const alignedTo = (codec: ExportCodec): Partial<ExportEncodingValue> => {
    const container = isExportCodecContainerCompatible(codec, value.container)
      ? value.container
      : getRecommendedContainerForCodec(codec);
    const audioMode = isExportAudioContainerCompatible(value.audioMode, container)
      ? value.audioMode
      : getRecommendedAudioForContainer(container);
    return { codec, container, audioMode };
  };

  // Le codec est le PREMIER choix : il entraîne le moteur (ProRes n'a pas d'encodeur matériel, donc
  // le laisser sur « GPU » affichait un réglage que rien n'exécutait), puis le conteneur, puis le
  // codec audio. Le moteur reste réglable à la main juste après — `pickEncoderMode` garde le codec.
  const alignedFromCodec = (codec: ExportCodec): Partial<ExportEncodingValue> => {
    const encoderMode = encoderModeForCodec(caps, codec);
    return { ...alignedTo(codec), ...(encoderMode ? { encoderMode } : {}) };
  };

  // Codec exécutable par ce moteur, en gardant la FAMILLE choisie si elle y existe (passer du GPU au
  // CPU ne doit pas faire basculer un H.265 en ProRes).
  const codecFor = (mode: ExportEncoderMode) => {
    const candidates = optionsForMode(mode);
    if (candidates.some((option) => option.value === value.codec)) return value.codec;
    return candidates.find((option) => getCodecFamily(option.value) === getCodecFamily(value.codec))?.value
      ?? candidates[0]?.value
      ?? fallbackCodecForEncoder(caps, value.codec, mode);
  };

  // Auto-réparation : profil importé d'une autre machine, moteur disparu (GPU débranché), ou codec
  // exclu par l'appelant (sortie alpha). Inerte tant que la sonde n'a pas répondu.
  useEffect(() => {
    if (!caps.codecs) return;
    if (!availableEncoderModes.includes(encoderMode)) {
      apply({ encoderMode: "cpu" });
      return;
    }
    const codec = codecFor(encoderMode);
    if (codec !== value.codec) apply(alignedTo(codec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps, encoderMode, value.codec, value.container, value.audioMode, allowedCodecs]);

  // Le catalogue n'est PLUS filtré par le moteur courant : c'est le codec qui fixe le moteur, donc
  // filtrer l'un par l'autre tournait en rond (choisir CPU cachait les codecs GPU, et inversement).
  // Seule la sonde tranche : un codec qu'aucun chemin n'exécute ici reste absent.
  const allCodecOptions = supportedCodecOptionsForEncoder(caps, "gpu")
    .concat(supportedCodecOptionsForEncoder(caps, "cpu"))
    .filter((option, i, all) => all.findIndex((o) => o.value === option.value) === i)
    .filter((option) => codecAllowed(option.value));
  const families = supportedCodecFamilies(caps)
    .filter((family) => codecsForFamily(family).some((codec) => allCodecOptions.some((o) => o.value === codec)));
  const profilesOfFamily = (family: ExportCodecFamily): Option<ExportCodec>[] =>
    codecsForFamily(family)
      .filter((codec) => allCodecOptions.some((o) => o.value === codec))
      .map((codec) => ({ value: codec, label: getExportCodecProfileLabel(codec) }));

  // Conteneurs réellement atteignables : ceux du codec vidéo, moins ce que l'écran s'interdit.
  const reachableContainers = compatibleContainersForExportCodec(value.codec)
    .filter((option) => !allowedContainers || allowedContainers.has(option.value));

  // Un codec audio est offert dès qu'UN de ces conteneurs le mux — pas seulement le conteneur
  // courant : le choisir bascule le conteneur (cf. pickAudio).
  const audioOptions = EXPORT_AUDIO_OPTIONS.filter((option) =>
    reachableContainers.some((container) => isExportAudioContainerCompatible(option.value, container.value)));
  const audioGroups = groupAudioOptions(audioOptions);

  return {
    encoderMode,
    speed,
    encoderItems: encoderModes.map((mode) => ({ value: mode, label: encoderLabel(mode) })),
    codecOptions: allCodecOptions,
    codecGroups: supportedCodecGroups(caps)
      .map((group) => ({ ...group, options: group.options.filter((option) => codecAllowed(option.value)) }))
      .filter((group) => group.options.length > 0),
    codecFamily: getCodecFamily(value.codec),
    codecFamilyOptions: families.map((family) => ({ value: family, label: getCodecFamilyLabel(family) })),
    pickCodecFamily: (family) => {
      const next = profilesOfFamily(family);
      if (next.length) apply(alignedFromCodec(next[0].value));
    },
    codecProfileOptions: profilesOfFamily(getCodecFamily(value.codec)),
    containerOptions: reachableContainers,
    audioOptions,
    audioLoneOptions: audioOptions.filter((option) => !audioGroups.some((group) => group.options.includes(option))),
    audioGroups,
    speedSettable: supportsExportSpeed(value.codec),
    // Le conteneur ne bouge QUE s'il refuse le codec demandé — choisir AAC en MOV ne doit pas
    // ramener le profil en MP4.
    pickAudio: (audioMode) => apply(isExportAudioContainerCompatible(audioMode, value.container)
      ? { audioMode }
      : { audioMode, container: reachableContainers.find((c) => isExportAudioContainerCompatible(audioMode, c.value))?.value ?? value.container }),
    pickEncoderMode: (mode) => apply({ encoderMode: mode, ...alignedTo(codecFor(mode)) }),
    pickCodec: (codec) => apply(alignedFromCodec(codec)),
    pickContainer: (container) => apply({
      container,
      audioMode: isExportAudioContainerCompatible(value.audioMode, container)
        ? value.audioMode
        : getRecommendedAudioForContainer(container),
    }),
  };
}
