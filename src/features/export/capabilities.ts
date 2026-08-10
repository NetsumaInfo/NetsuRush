// Capacités d'export RÉELLES de la machine → ce qu'on propose dans l'UI.
//
// Le core sonde le vrai ffmpeg en encodant une frame par codec (cf. core/export/capabilities.js) :
// un codec listé par ffmpeg mais que le matériel ne sait pas exécuter (av1_nvenc sur une RTX 30xx,
// qsv sans GPU Intel…) n'est PAS proposé. Exigence produit : ce qui n'est pas compatible ne s'affiche
// tout simplement pas.
//
// Prudence volontaire : tant que la sonde n'a pas répondu — ou si elle échoue — on n'enlève RIEN
// (liste complète). Masquer sur une erreur transitoire priverait l'utilisateur de tous ses codecs.
import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { loadCompatibility } from "@/hooks/useCompatibility";
import {
  type ExportCodec, type ExportEncoderMode,
  EXPORT_CODEC_OPTIONS, EXPORT_CODEC_GROUPS, getCodecFamily,
} from "./profiles";

export interface ExportCapabilities {
  // null = inconnu (sonde en cours ou en échec) → on ne filtre pas.
  codecs: Set<ExportCodec> | null;
  cpuCodecs: Set<ExportCodec> | null;
  hasGpuEncoder: boolean;
  hwEncoders: string[];
  codecEncoderOptions: Record<string, string[]>;
}

const UNKNOWN: ExportCapabilities = {
  codecs: null,
  cpuCodecs: null,
  hasGpuEncoder: false,
  hwEncoders: [],
  codecEncoderOptions: {},
};

// La sonde coûte quelques secondes au premier appel (puis cache disque côté core) → une seule
// promesse partagée par toute l'app, jamais une par composant monté.
let cache: Promise<ExportCapabilities> | null = null;

export function loadExportCapabilities(): Promise<ExportCapabilities> {
  if (!cache) {
    cache = nr
      .exportCapabilities()
      .then(async (r) => {
        if (!r.ok || !Array.isArray(r.codecs) || !r.codecs.length) return UNKNOWN;
        // Compatibilité avec un core déjà lancé avant l'ajout des champs détaillés : sa réponse
        // export contient encore codecs/hwEncoders, tandis que compat:status expose déjà le verdict
        // complet. La prochaine relance lira directement le cache disque au nouveau format.
        const legacyShape = !Array.isArray(r.cpuCodecs) || !r.codecEncoderOptions;
        const compatibility = legacyShape ? await loadCompatibility().catch(() => null) : null;
        const codecEncoderOptions = r.codecEncoderOptions
          ?? compatibility?.encoding.codecEncoderOptions
          ?? {};
        const cpuCodecs = Array.isArray(r.cpuCodecs) ? r.cpuCodecs : r.codecs;
        const hwEncoders = r.hwEncoders?.length
          ? r.hwEncoders
          : compatibility?.encoding.hardwareEncoders ?? [];
        return {
          codecs: new Set(r.codecs as ExportCodec[]),
          cpuCodecs: new Set(cpuCodecs as ExportCodec[]),
          hasGpuEncoder: Object.values(codecEncoderOptions).some((encoders) => encoders.length > 0),
          hwEncoders,
          codecEncoderOptions,
        };
      })
      .catch(() => UNKNOWN);
  }
  return cache;
}

export function useExportCapabilities(): ExportCapabilities {
  const [caps, setCaps] = useState<ExportCapabilities>(UNKNOWN);
  useEffect(() => {
    let alive = true;
    void loadExportCapabilities().then((c) => { if (alive) setCaps(c); });
    return () => { alive = false; };
  }, []);
  return caps;
}

function isCodecSupported(caps: ExportCapabilities, codec: ExportCodec): boolean {
  return !caps.codecs || caps.codecs.has(codec);
}

function supportedCodecOptions(caps: ExportCapabilities): { value: ExportCodec; label: string }[] {
  return EXPORT_CODEC_OPTIONS.filter((o) => isCodecSupported(caps, o.value));
}

const MODE_SUFFIX: Partial<Record<ExportEncoderMode, string>> = {
  nvenc: "_nvenc",
  amf: "_amf",
  qsv: "_qsv",
};

function isCodecSupportedForEncoder(
  caps: ExportCapabilities,
  codec: ExportCodec,
  mode: ExportEncoderMode,
): boolean {
  if (!isCodecSupported(caps, codec)) return false;
  if (mode === "cpu") return !caps.cpuCodecs || caps.cpuCodecs.has(codec);
  if (mode === "gpu") return (caps.codecEncoderOptions[codec] ?? []).length > 0;
  const suffix = MODE_SUFFIX[mode];
  return !!suffix && (caps.codecEncoderOptions[codec] ?? []).some((encoder) => encoder.endsWith(suffix));
}

export function supportedEncoderModes(caps: ExportCapabilities): ExportEncoderMode[] {
  const modes: ExportEncoderMode[] = [];
  if (EXPORT_CODEC_OPTIONS.some((option) => isCodecSupportedForEncoder(caps, option.value, "gpu"))) modes.push("gpu");
  for (const mode of ["nvenc", "amf", "qsv"] as const) {
    if (EXPORT_CODEC_OPTIONS.some((option) => isCodecSupportedForEncoder(caps, option.value, mode))) modes.push(mode);
  }
  modes.push("cpu");
  return modes;
}

export function supportedCodecOptionsForEncoder(
  caps: ExportCapabilities,
  mode: ExportEncoderMode,
): { value: ExportCodec; label: string }[] {
  if (!caps.codecs) return mode === "cpu" ? EXPORT_CODEC_OPTIONS : [];
  return EXPORT_CODEC_OPTIONS.filter((option) => isCodecSupportedForEncoder(caps, option.value, mode));
}

function automaticMode(caps: ExportCapabilities, codec: ExportCodec): Exclude<ExportEncoderMode, "gpu"> {
  const encoder = (caps.codecEncoderOptions[codec] ?? [])[0] ?? "";
  if (encoder.endsWith("_nvenc")) return "nvenc";
  if (encoder.endsWith("_amf")) return "amf";
  if (encoder.endsWith("_qsv")) return "qsv";
  return "cpu";
}

const MODE_LABELS: Record<Exclude<ExportEncoderMode, "gpu">, string> = {
  nvenc: "GPU · NVIDIA NVENC",
  amf: "GPU · AMD AMF",
  qsv: "GPU · Intel Quick Sync",
  cpu: "CPU",
};

// Tri principal par moteur (GPU en premier, CPU en bas), puis par famille de codec.
export function supportedCodecGroups(caps: ExportCapabilities, mode: ExportEncoderMode) {
  if (!caps.codecs) {
    return mode === "cpu" ? EXPORT_CODEC_GROUPS.map((group) => ({
      key: group.family,
      label: group.label,
      options: group.options,
    })) : [];
  }
  const modes = mode === "gpu" ? (["nvenc", "amf", "qsv"] as const) : [mode];
  return modes.flatMap((groupMode) => EXPORT_CODEC_GROUPS.map((group) => ({
    key: `${groupMode}-${group.family}`,
    label: `${MODE_LABELS[groupMode as Exclude<ExportEncoderMode, "gpu">]} · ${group.label}`,
    options: group.options.filter((option) => mode === "gpu"
      ? automaticMode(caps, option.value) === groupMode && isCodecSupported(caps, option.value)
      : isCodecSupportedForEncoder(caps, option.value, groupMode)),
  }))).filter((group) => group.options.length > 0);
}

// Codec de repli si celui du profil n'est pas exécutable ici (profil venu d'une autre machine, ou
// import d'un preset) : on reste dans la même famille si possible, sinon premier codec supporté.
export function fallbackCodec(caps: ExportCapabilities, codec: ExportCodec): ExportCodec {
  if (isCodecSupported(caps, codec)) return codec;
  const fam = getCodecFamily(codec);
  const opts = supportedCodecOptions(caps);
  return opts.find((o) => getCodecFamily(o.value) === fam)?.value ?? opts[0]?.value ?? codec;
}

export function fallbackCodecForEncoder(
  caps: ExportCapabilities,
  codec: ExportCodec,
  mode: ExportEncoderMode,
): ExportCodec {
  if (isCodecSupportedForEncoder(caps, codec, mode)) return codec;
  const family = getCodecFamily(codec);
  const options = supportedCodecOptionsForEncoder(caps, mode);
  return options.find((option) => getCodecFamily(option.value) === family)?.value ?? options[0]?.value ?? codec;
}
