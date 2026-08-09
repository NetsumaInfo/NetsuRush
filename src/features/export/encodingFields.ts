// Logique PARTAGÉE des champs d'encodage (moteur, vitesse, codec, codec audio, conteneur).
//
// Trois écrans posent exactement les mêmes questions dans des mises en page différentes : l'éditeur de
// profil d'export, les réglages du hub NetsuLab et l'archivage d'une collection. Ce qui doit rester
// identique n'est pas le rendu mais les GARDE-FOUS : moteurs réellement sondés, codecs exécutables par
// ce moteur, conteneur compatible du codec, codec audio compatible du conteneur — et la cascade qui
// réaligne le tout quand on change un maillon. Dupliquée, cette cascade divergeait au premier oubli
// (l'archivage proposait FLAC en MP4, que ffmpeg refuse).
//
// Le rendu reste à l'appelant : ce module ne connaît ni composant ni classe CSS.
import { useEffect } from "react";
import i18n from "@/i18n";
import {
  coerceExportEncoderMode,
  coerceExportSpeed,
  compatibleAudioForContainer,
  compatibleAudioGroupsForContainer,
  compatibleContainersForExportCodec,
  getCodecFamily,
  getRecommendedAudioForContainer,
  getRecommendedContainerForCodec,
  isExportAudioContainerCompatible,
  isExportCodecContainerCompatible,
  supportsExportSpeed,
  type ExportAudioMode,
  type ExportCodec,
  type ExportContainer,
  type ExportEncoderMode,
  type ExportSpeed,
} from "./profiles";
import {
  fallbackCodecForEncoder,
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
  containerOptions: Option<ExportContainer>[];
  audioOptions: Option<ExportAudioMode>[];
  /** Codecs audio hors famille (« Copie ») — à rendre avant les groupes. */
  audioLoneOptions: Option<ExportAudioMode>[];
  audioGroups: { family: string; label: string; options: Option<ExportAudioMode>[] }[];
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
  options: { allowedCodecs?: ReadonlySet<ExportCodec> } = {},
): ExportEncodingFields {
  const caps = useExportCapabilities();
  const { allowedCodecs } = options;
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

  const audioOptions = compatibleAudioForContainer(value.container);
  const audioGroups = compatibleAudioGroupsForContainer(value.container);

  return {
    encoderMode,
    speed,
    encoderItems: encoderModes.map((mode) => ({ value: mode, label: encoderLabel(mode) })),
    codecOptions: optionsForMode(encoderMode),
    codecGroups: supportedCodecGroups(caps, encoderMode)
      .map((group) => ({ ...group, options: group.options.filter((option) => codecAllowed(option.value)) }))
      .filter((group) => group.options.length > 0),
    containerOptions: compatibleContainersForExportCodec(value.codec),
    audioOptions,
    audioLoneOptions: audioOptions.filter((option) => !audioGroups.some((group) => group.options.includes(option))),
    audioGroups,
    speedSettable: supportsExportSpeed(value.codec),
    pickEncoderMode: (mode) => apply({ encoderMode: mode, ...alignedTo(codecFor(mode)) }),
    pickCodec: (codec) => apply(alignedTo(codec)),
    pickContainer: (container) => apply({
      container,
      audioMode: isExportAudioContainerCompatible(value.audioMode, container)
        ? value.audioMode
        : getRecommendedAudioForContainer(container),
    }),
  };
}
