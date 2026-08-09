import type { UpscaleModel, UpscaleCodec, AudioMode, ShaderModel, CompatibilityStatus } from "@/lib/bridge";
import { DEFAULT_PROCESS_EXPORT, type ProcessExportSettings } from "./processExport";

// Modèles. Fallin/CUGAN/LD-Anime = via Spandrel (poids OpenModelDB) ; les autres = Real-ESRGAN.
// `label` = NOM EXACT du modèle (= fichier de poids / dépôt du manifeste core/models.js), jamais son
// usage — celui-ci vit dans `hint`. Source unique : le code lit ces constantes, PAS les locales.
// `auto` = poids récupérés au 1er usage (sinon manuel, MEGA). `board` = legacy (ancien sous-ensemble
// épuré) — la popup du board expose désormais TOUS les modèles, avec un défaut réglable en Paramètres.
//
// `native` et `tuning` décrivent ce que le RÉSEAU sait faire, et pilotent les réglages affichés :
//  - `native` = facteur d'agrandissement du réseau (miroir de `netscale` dans python/upscaler/models.py).
//    Demander un autre facteur reste possible, mais c'est un rééchantillonnage APRÈS le modèle, pas
//    une meilleure reconstruction — le panneau le dit au lieu de laisser croire l'inverse.
//  - `tuning: "onnx-window"` = graphe ONNX à dimensions FIGÉES (cf. FixedOnnxUpsampler) : ni tuile,
//    ni marge de bord, ni précision à choisir ; seul le recouvrement des fenêtres agit. Afficher les
//    autres curseurs donnerait des réglages sans le moindre effet.
export interface UpModelEntry {
  id: UpscaleModel;
  label: string;
  hint: string;
  native: 1 | 2 | 4;
  tuning: "torch" | "onnx-window";
  denoise: boolean;
  auto: boolean;
  board: boolean;
}

export const UP_MODELS: UpModelEntry[] = [
  // MÊME ordre que la sélection courante du registre (lib/modelRegistry) : les modèles retenus en
  // tête, les variantes ensuite. Le premier sert de valeur par défaut au passage en mode upscale.
  { id: "anime", label: "Real-ESRGAN AnimeVideo v3", hint: "Anime 4× — tout-terrain.", native: 4, tuning: "torch", denoise: false, auto: true, board: true },
  { id: "general", label: "Real-ESRGAN x4plus", hint: "Réel 4× — qualité maximale.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "cugan", label: "Real-CUGAN up2x denoise3x", hint: "Anime 2× — débruitage intégré.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "animesr", label: "AnimeSR v2", hint: "Anime 4× VIDÉO — mémoire entre images, plus stable dans le temps.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "shufflecugan", label: "sudo ShuffleCUGAN", hint: "Anime 2× — le plus rapide.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "light", label: "Real-ESRGAN General x4 v3", hint: "Réel 4× — rapide, débruitage réglable.", native: 4, tuning: "torch", denoise: true, auto: true, board: true },
  { id: "fallin", label: "Fallin Soft", hint: "Anime 2× — doux, anti-artefacts.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "fallin_strong", label: "Fallin Strong", hint: "Anime 2× — net, traits marqués.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "adore", label: "Adore", hint: "Anime 2× — rapide, image propre.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ld_anime", label: "LD-Anime Compact 2x", hint: "Anime 2× — vieux DVD/VHS abîmés.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "aniscale2", label: "AniScale2S Compact", hint: "Anime 2× — compact et rapide.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "open-proteus", label: "OpenProteus Compact", hint: "Anime 2× — reconstruction douce.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "span", label: "ModernSpanimation V2", hint: "Anime 2× — SPAN polyvalent.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "rtmosr", label: "umzi Anime RTMoSR", hint: "Anime 2× — traits fins préservés.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "smosr", label: "SMoSR v1 2x", hint: "Anime 2× — mélange d'experts.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "figsr", label: "FIGSR 2x", hint: "Anime 2× — reconstruction fréquentielle (FFT).", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "saryn", label: "Saryn V1 Lite", hint: "Anime 2× — léger et rapide.", native: 2, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "shufflespan", label: "sudo Shuffle SPAN 10.5M", hint: "Anime 2× — ONNX, fenêtres 1080p.", native: 2, tuning: "onnx-window", denoise: false, auto: true, board: false },
  // NTIRE 2026 Efficient SR (MIT) : ×4 photographique, poids minuscules, entraînés sur une réduction
  // bicubique propre — ils reconstruisent une source NETTE et ne corrigent ni bruit ni compression.
  { id: "ntire-span", label: "SPAN", hint: "Réel 4× — référence NTIRE.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-pds", label: "PDS", hint: "Réel 4× — très léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-zenosr", label: "ZenoSR", hint: "Réel 4× — le plus petit.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-haesr", label: "HAESR", hint: "Réel 4× — le plus gros.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-rfdn-span", label: "RFDN-SPAN", hint: "Réel 4× — RFDN + SPAN.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-hfenet", label: "HFENet", hint: "Réel 4× — léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-vscinet", label: "VSCINet", hint: "Réel 4× — très léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-dscf", label: "DSCF-Fused", hint: "Réel 4× — très léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-pkdsr", label: "PKDSR", hint: "Réel 4× — SPAN élagué.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-amcanet", label: "AMCANet", hint: "Réel 4× — léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-disp", label: "DISP", hint: "Réel 4× — léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-bviesr", label: "BVI-SRF", hint: "Réel 4× — léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-errn2", label: "ERRN2", hint: "Réel 4× — léger.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "ntire-safmn", label: "SAFMN-Deep15", hint: "Réel 4× — SAFMN profond.", native: 4, tuning: "torch", denoise: false, auto: true, board: false },
];

// Codec = famille + variante. Diffusion = H.264/HEVC (x264/x265, CRF/preset). Montage = ProRes/DNxHR
// (profils fixes, intra-frame, 10-bit). Les libellés sont les vrais noms de codec, pas des pseudo-presets.
export type UpscaleFamily = "h264" | "hevc" | "prores" | "dnxhr";

export const UP_FAMILIES: { id: UpscaleFamily; label: string; group: "diffusion" | "montage"; hint: string }[] = [
  { id: "h264", label: "H.264", group: "diffusion", hint: "libx264 — diffusion universelle, MP4" },
  { id: "hevc", label: "HEVC", group: "diffusion", hint: "libx265 — diffusion compacte, 8/10-bit, MP4" },
  { id: "prores", label: "ProRes", group: "montage", hint: "Apple ProRes — intermédiaire montage, MOV" },
  { id: "dnxhr", label: "DNxHR", group: "montage", hint: "Avid DNxHR — intermédiaire montage, MOV" },
];

// Variantes par famille — libellés = noms complets explicites (l'utilisateur sait ce qu'il choisit).
export const UP_VARIANTS: Record<UpscaleFamily, { id: UpscaleCodec; label: string; hint: string }[]> = {
  h264: [
    { id: "h264_gpu", label: "H.264 · GPU", hint: "Utilise automatiquement la carte graphique détectée." },
    { id: "h264_nvenc", label: "H.264 · NVIDIA NVENC", hint: "Encode avec le moteur NVIDIA NVENC." },
    { id: "h264_amf", label: "H.264 · AMD AMF", hint: "Encode avec le moteur AMD AMF." },
    { id: "h264_qsv", label: "H.264 · Intel Quick Sync", hint: "Encode avec le moteur Intel Quick Sync." },
    { id: "x264", label: "H.264 · CPU", hint: "libx264 — qualité max mais lent (CPU)" },
  ],
  hevc: [
    { id: "hevc_gpu", label: "HEVC · GPU", hint: "Utilise automatiquement la carte graphique détectée." },
    { id: "hevc_nvenc", label: "HEVC · NVIDIA NVENC", hint: "Encode avec le moteur NVIDIA NVENC." },
    { id: "hevc_amf", label: "HEVC · AMD AMF", hint: "Encode avec le moteur AMD AMF." },
    { id: "hevc_qsv", label: "HEVC · Intel Quick Sync", hint: "Encode avec le moteur Intel Quick Sync." },
    { id: "x265", label: "HEVC · CPU", hint: "libx265 — qualité max mais lent (CPU)" },
  ],
  prores: [
    { id: "prores_proxy", label: "ProRes 422 Proxy", hint: "le plus léger" },
    { id: "prores_lt", label: "ProRes 422 LT", hint: "léger" },
    { id: "prores_422", label: "ProRes 422", hint: "standard montage" },
    { id: "prores_hq", label: "ProRes 422 HQ", hint: "haute qualité" },
    { id: "prores_4444", label: "ProRes 4444", hint: "alpha, 10-bit" },
    { id: "prores_4444xq", label: "ProRes 4444 XQ", hint: "débit max, alpha" },
  ],
  dnxhr: [
    { id: "dnxhr_lb", label: "DNxHR LB", hint: "faible débit" },
    { id: "dnxhr_sq", label: "DNxHR SQ", hint: "qualité standard" },
    { id: "dnxhr_hq", label: "DNxHR HQ", hint: "haute qualité 8-bit" },
    { id: "dnxhr_hqx", label: "DNxHR HQX", hint: "haute qualité 10-bit" },
    { id: "dnxhr_444", label: "DNxHR 444", hint: "4:4:4 10-bit" },
  ],
};

// Libellé complet d'un codec (déclencheur du sélecteur) + liste plate (Base UI Root items).
export function codecLabel(codec: UpscaleCodec, status: CompatibilityStatus | null = null): string {
  for (const f of UP_FAMILIES) {
    const v = variantsFor(f.id, status).find((x) => x.id === codec)
      || UP_VARIANTS[f.id].find((x) => x.id === codec);
    if (v) return v.label;
  }
  return codec;
}
export const UP_CODEC_ITEMS = UP_FAMILIES.flatMap((f) =>
  UP_VARIANTS[f.id].map((v) => ({ value: v.id, label: v.label })),
);

const isHardwareCodec = (codec: UpscaleCodec): boolean => /^(?:h264|hevc)_(?:gpu|nvenc|amf|qsv)$/.test(codec);
const encoderVendor = (codec: UpscaleCodec): "nvidia" | "amd" | "intel" | null => {
  if (codec.endsWith("_nvenc")) return "nvidia";
  if (codec.endsWith("_amf")) return "amd";
  if (codec.endsWith("_qsv")) return "intel";
  return null;
};
const detectedEncoder = (encoder: string, status: CompatibilityStatus): boolean => {
  const vendor = encoder.endsWith("_nvenc") ? "nvidia"
    : encoder.endsWith("_amf") ? "amd"
      : encoder.endsWith("_qsv") ? "intel" : null;
  return !!vendor && status.hardware.primaryVendor === vendor;
};

// Chaque moteur matériel réellement sondé est proposé séparément. Sur une machine hybride, NVENC,
// AMF et Quick Sync peuvent donc coexister au lieu d'être écrasés par le premier moteur retenu.
export function variantsFor(family: UpscaleFamily, status: CompatibilityStatus | null) {
  return UP_VARIANTS[family].filter((variant) => {
    if (!isHardwareCodec(variant.id)) return true;
    if (!status) return false;
    if (variant.id.endsWith("_gpu")) {
      return Object.entries(status.encoding.codecEncoderOptions)
        .some(([key, encoders]) => key.startsWith(family === "h264" ? "h264_" : "h265_")
          && encoders.some((encoder) => detectedEncoder(encoder, status)));
    }
    const vendor = encoderVendor(variant.id);
    if (!vendor || status.hardware.primaryVendor !== vendor) return false;
    return Object.values(status.encoding.codecEncoderOptions)
      .some((encoders) => encoders.includes(variant.id));
  });
}

// Codecs réglables (CPU + moteurs matériels explicites) → exposent qualité, vitesse, profil codec.
export const ENCODER_CODECS = new Set<UpscaleCodec>([
  "x264", "x265", "h264_gpu", "hevc_gpu", "h264_nvenc", "h264_amf", "h264_qsv", "hevc_nvenc", "hevc_amf", "hevc_qsv",
]);
export const GPU_CODECS = new Set<UpscaleCodec>([
  "h264_gpu", "hevc_gpu", "h264_nvenc", "h264_amf", "h264_qsv", "hevc_nvenc", "hevc_amf", "hevc_qsv",
]);

// Profils codec RÉELS (-profile:v) par codec réglable — miroir de python/upscaler/codecs.py.PROFILES.
// Le profil porte le sous-échantillonnage chroma + la profondeur → remplace le toggle 8/10-bit
// (un seul sélecteur). NVENC H.264 = pas de 10-bit ; NVENC HEVC = 4:2:0 seul (matériel).
export const UP_PROFILES: Partial<Record<UpscaleCodec, { value: string; label: string }[]>> = {
  x264: [
    { value: "baseline", label: "Baseline · 8-bit 4:2:0" },
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "high", label: "High · 8-bit 4:2:0" },
    { value: "high10", label: "High 10 · 10-bit 4:2:0" },
    { value: "high422", label: "High 4:2:2 · 10-bit" },
    { value: "high444", label: "High 4:4:4 · 10-bit" },
  ],
  h264_nvenc: [
    { value: "baseline", label: "Baseline · 8-bit 4:2:0" },
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "high", label: "High · 8-bit 4:2:0" },
    { value: "high444", label: "High 4:4:4 · 8-bit" },
  ],
  h264_gpu: [
    { value: "baseline", label: "Baseline · 8-bit 4:2:0" },
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "high", label: "High · 8-bit 4:2:0" },
  ],
  h264_amf: [
    { value: "baseline", label: "Baseline · 8-bit 4:2:0" },
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "high", label: "High · 8-bit 4:2:0" },
  ],
  h264_qsv: [
    { value: "baseline", label: "Baseline · 8-bit 4:2:0" },
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "high", label: "High · 8-bit 4:2:0" },
  ],
  x265: [
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "main10", label: "Main 10 · 10-bit 4:2:0" },
    { value: "main12", label: "Main 12 · 12-bit 4:2:0" },
    { value: "main422-10", label: "Main 4:2:2 · 10-bit" },
    { value: "main422-12", label: "Main 4:2:2 · 12-bit" },
    { value: "main444-8", label: "Main 4:4:4 · 8-bit" },
    { value: "main444-10", label: "Main 4:4:4 · 10-bit" },
    { value: "main444-12", label: "Main 4:4:4 · 12-bit" },
  ],
  hevc_nvenc: [
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "main10", label: "Main 10 · 10-bit 4:2:0" },
    { value: "rext444-8", label: "Main 4:4:4 · 8-bit (rext)" },
    { value: "rext444-10", label: "Main 4:4:4 · 10-bit (rext)" },
  ],
  hevc_gpu: [
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "main10", label: "Main 10 · 10-bit 4:2:0" },
    { value: "rext444-8", label: "Main 4:4:4 · 8-bit (RExt)" },
    { value: "rext444-10", label: "Main 4:4:4 · 10-bit (RExt)" },
  ],
  hevc_amf: [
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "main10", label: "Main 10 · 10-bit 4:2:0" },
  ],
  hevc_qsv: [
    { value: "main", label: "Main · 8-bit 4:2:0" },
    { value: "main10", label: "Main 10 · 10-bit 4:2:0" },
  ],
};
const DEFAULT_PROFILE: Partial<Record<UpscaleCodec, string>> = {
  x264: "high", h264_gpu: "high", h264_nvenc: "high", h264_amf: "high", h264_qsv: "high",
  x265: "main", hevc_gpu: "main", hevc_nvenc: "main", hevc_amf: "main", hevc_qsv: "main",
};
export const profilesFor = (codec: UpscaleCodec) => UP_PROFILES[codec] ?? [];
export function compatibleProfilesFor(codec: UpscaleCodec, status: CompatibilityStatus | null) {
  const all = profilesFor(codec);
  if (!status || !GPU_CODECS.has(codec)) return all;
  const keyFor = (profile: string) => codec.startsWith("h264_")
    ? `h264_${profile}`
    : profile === "rext444-8" ? "h265_rext444_8"
      : profile === "rext444-10" ? "h265_rext444_10" : `h265_${profile}`;
  return all.filter((entry) => {
    const key = keyFor(entry.value);
    if (!key) return false;
    const encoders = status.encoding.upscaleProfileEncoderOptions[key] ?? [];
    if (codec.endsWith("_gpu")) return encoders.some((encoder) => detectedEncoder(encoder, status));
    return encoders.includes(codec) && !!encoderVendor(codec)
      && status.hardware.primaryVendor === encoderVendor(codec);
  });
}
export const defaultProfile = (codec: UpscaleCodec) => DEFAULT_PROFILE[codec] ?? "";
// Profil valide pour ce codec, sinon son défaut — appelé au changement de codec (les profils diffèrent).
export function coerceProfile(codec: UpscaleCodec, profile: string): string {
  return profilesFor(codec).some((o) => o.value === profile) ? profile : defaultProfile(codec);
}
// Profondeur (8/10) impliquée par le profil → garde `bitDepth` cohérent pour les chemins legacy.
// bitDepth est un union 8|10 (legacy) ; 12-bit → 10 (le backend lit le pix_fmt du profil, pas bitDepth).
export function profileDepth(codec: UpscaleCodec, profile: string): 8 | 10 {
  const l = profilesFor(codec).find((o) => o.value === profile)?.label ?? "";
  return l.includes("8-bit") ? 8 : 10;
}

export function familyOf(codec: UpscaleCodec): UpscaleFamily {
  if (codec === "x264" || codec.startsWith("h264_")) return "h264";
  if (codec === "x265" || codec.startsWith("hevc_")) return "hevc";
  return codec.startsWith("prores") ? "prores" : "dnxhr";
}

// x1 = restauration/débruitage à la taille d'origine (le modèle nettoie puis redescend à la source).
export const UP_SCALES: (1 | 2 | 4)[] = [1, 2, 4];

// Moteur d'upscale : IA (Real-ESRGAN/CUGAN, lent, qualité max) ou Turbo (shader GLSL libplacebo,
// GPU temps réel, qualité « suffisante »). Le moteur Turbo réutilise échelle/codec/audio/export.
export type UpEngine = "ia" | "turbo";

// Panier « temps réel » : tout ce qui tourne sur GPU sans passer par un gros réseau lent, quelle que
// soit la technique derrière (shader GLSL libplacebo, poids ArtCNN R en ONNX, ou le CLI NVIDIA
// RTX VSR). `label` = nom exact du modèle ; `hint` = infobulle, la plus courte possible — c'est un
// choix, pas une notice. Suffixes ArtCNN : DS = débruite + accentue, DN = débruite + adoucit.
export const SHADER_MODELS: { id: ShaderModel; label: string; hint: string }[] = [
  { id: "artcnn_r16f96", label: "ArtCNN R16F96", hint: "Anime — qualité max." },
  { id: "artcnn_r8f64", label: "ArtCNN R8F64", hint: "Anime — qualité, plus rapide." },
  { id: "artcnn_c4f32", label: "ArtCNN C4F32", hint: "Anime — équilibré." },
  { id: "artcnn_c4f32_ds", label: "ArtCNN C4F32 DS", hint: "Anime — débruite, accentue." },
  { id: "artcnn_c4f32_dn", label: "ArtCNN C4F32 DN", hint: "Anime — débruite, adoucit." },
  { id: "artcnn_c4f16", label: "ArtCNN C4F16", hint: "Anime — le plus rapide." },
  { id: "artcnn_c4f16_ds", label: "ArtCNN C4F16 DS", hint: "Rapide — débruite, accentue." },
  { id: "artcnn_c4f16_dn", label: "ArtCNN C4F16 DN", hint: "Rapide — débruite, adoucit." },
  { id: "anime4k_aa_hq", label: "Anime4K mode A+A HQ", hint: "Anime — perceptuel max." },
  { id: "anime4k_bb_hq", label: "Anime4K mode B+B HQ", hint: "Anime — restauration douce." },
  { id: "rtx_vsr", label: "NVIDIA RTX VSR", hint: "Réel et anime — 2× fixe, NVIDIA." },
  { id: "lanczos", label: "Lanczos-sharp", hint: "Réel — sans IA, instantané." },
];

// RTX VSR n'agrandit qu'en ×2 (contrainte du SDK) et n'accepte pas les sources ≥ 1440p.
export const RTX_SHADER: ShaderModel = "rtx_vsr";
export const isRtxShader = (shader: ShaderModel) => shader === RTX_SHADER;
// RTX VSR a besoin du CLI ET des bibliothèques NVIDIA, mais les deux forment UNE entrée de catalogue
// (cf. lib/modelRegistry) : le gestionnaire ne déclare « installé » que lorsque les deux sont là.
export const RTX_RUNTIME_IDS = ["rtx-video"];

// Réglages propres au RTX Video SDK. Qualité VSR = 4 paliers du SDK (1 le plus rapide, 4 le meilleur).
export const RTX_QUALITIES: { value: 1 | 2 | 3 | 4; label: string }[] = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
];
// TrueHDR : conversion SDR → HDR10 du même SDK. Valeurs par défaut = celles du SDK (125/100/25/1000).
export const RTX_HDR_CONTRAST: number[] = [100, 125, 150, 175];
export const RTX_HDR_SATURATION: number[] = [75, 100, 125, 150];
export const RTX_HDR_MIDGRAY: number[] = [15, 20, 25, 30, 35];
export const RTX_HDR_NITS: number[] = [400, 600, 1000, 1500, 4000];

// Restauration : `native: 1` sur toute la liste — ces réseaux nettoient à la taille d'origine.
export const RESTORE_MODELS: UpModelEntry[] = [
  { id: "tas-anime1080fixer", label: "Anime1080Fixer", hint: "Anime 1× — défauts d'encodage et détails fins.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-deh264-real", label: "DeH264 Real-PLKSR", hint: "Réel 1× — artefacts H.264.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-scunet", label: "SCUNet Color Real PSNR", hint: "Réel 1× — débruitage photographique.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-nafnet", label: "NAFNet GoPro width64", hint: "Réel 1× — défloutage de mouvement.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-deh264-span", label: "DeH264 SPAN", hint: "Anime 1× — blocs et bavures H.264.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-dpir", label: "DRUNet Deblocking Color", hint: "1× — déblocage de compression.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-real-plksr", label: "Real-PLKSR DeJPEG", hint: "1× — artefacts JPEG et ringing.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-hurrdeblur", label: "HurrDeblur SuperUltraCompact", hint: "1× — défloutage compact et rapide.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
  { id: "tas-dehalo", label: "DeHalo v1 Compact", hint: "1× — halos autour des contours.", native: 1, tuning: "torch", denoise: false, auto: true, board: false },
];

// Ce que le modèle choisi rend RÉGLABLE. Le panneau s'en sert pour n'afficher que les contrôles qui
// changent quelque chose : un curseur sans effet se lit comme un réglage cassé.
export interface UpModelCaps {
  native: 1 | 2 | 4;
  denoise: boolean;     // débruitage DNI (interpolation entre deux poids) — un seul modèle le gère
  tile: boolean;        // découpe en tuiles + marge de bord + précision fp16/fp32
  tilePad: boolean;     // recouvrement : agit aussi sur le graphe ONNX à fenêtres figées
}

export function modelCaps(id: string): UpModelCaps | null {
  const entry = [...UP_MODELS, ...RESTORE_MODELS].find((m) => m.id === id);
  if (!entry) return null;
  const windowed = entry.tuning === "onnx-window";
  return { native: entry.native, denoise: entry.denoise, tile: !windowed, tilePad: true };
}

export const shaderRuntimeModel = (shader: ShaderModel): UpscaleModel | null =>
  shader === "artcnn_r16f96" || shader === "artcnn_r8f64" ? shader : null;

// Liste UNIFIÉE « Modèle » du board = modèles IA (Real-ESRGAN/CUGAN) + shaders Turbo (libplacebo),
// listés par leur VRAI nom (pas de catégorie « moteur/IA/turbo » exposée). Le moteur est déduit de
// l'id choisi (`boardUpEngine`). Les shaders sont vidéo-only → la popup image ne montre que les IA.
export type BoardUpChoice = { value: string; label: string; hint: string; engine: "ia" | "turbo" };
export const BOARD_UP_CHOICES: BoardUpChoice[] = [
  ...UP_MODELS.map((m): BoardUpChoice => ({ value: m.id, label: m.label, hint: m.hint, engine: "ia" })),
  ...SHADER_MODELS.map((m): BoardUpChoice => ({ value: m.id, label: m.label, hint: m.hint, engine: "turbo" })),
];
export const boardUpEngine = (value: string): "ia" | "turbo" =>
  SHADER_MODELS.some((m) => m.id === value) ? "turbo" : "ia";

// Réglages propres au moteur Turbo (options libplacebo, GPU, sans réglage couleur pour ne pas décaler).
export type TurboDeband = "none" | "light" | "medium" | "strong";
export type TurboSharp = "soft" | "sharp";
export const TURBO_DEBAND: { value: TurboDeband; label: string }[] = [
  { value: "none", label: "Aucun" },
  { value: "light", label: "Léger" },
  { value: "medium", label: "Moyen" },
  { value: "strong", label: "Fort" },
];
export const TURBO_SHARP: { value: TurboSharp; label: string }[] = [
  { value: "soft", label: "Doux" },
  { value: "sharp", label: "Net" },
];

// Vitesse d'encodage x264/x265 en langage clair (le preset technique reste sous le capot).
// Plus lent = meilleure compression à qualité égale. "Équilibré" = défaut.
export const UP_SPEEDS: { value: string; label: string; hint: string }[] = [
  { value: "veryfast", label: "Rapide", hint: "encode vite, fichier plus gros" },
  { value: "medium", label: "Équilibré", hint: "bon compromis" },
  { value: "slow", label: "Qualité", hint: "plus lent, plus compact" },
  { value: "veryslow", label: "Maximale", hint: "le plus compact, très lent" },
];
export function speedLabel(preset: string): string {
  return UP_SPEEDS.find((s) => s.value === preset)?.label ?? "Équilibré";
}

// Qualité d'encodage = profils par usage (comme les profils codec, pas des adjectifs).
// La valeur reste le CRF CPU / contrôle de qualité matériel envoyé à ffmpeg.
export const UP_QUALITIES: { value: number; label: string; hint: string }[] = [
  { value: 14, label: "Master", hint: "CRF 14 — archivage, sans perte visible, fichier lourd" },
  { value: 18, label: "Diffusion HQ", hint: "CRF 18 — YouTube/réseaux, haute qualité (recommandé)" },
  { value: 22, label: "Diffusion", hint: "CRF 22 — web standard, bon compromis poids" },
  { value: 26, label: "Web léger", hint: "CRF 26 — partage rapide, fichier réduit" },
  { value: 30, label: "Aperçu", hint: "CRF 30 — brouillon/preview, le plus léger" },
];

// Snap une valeur persistée (ancien réglage libre) sur le palier le plus proche ; égalité → meilleure qualité.
export function nearestOf(values: number[], v: number): number {
  return values.reduce((best, q) => (Math.abs(q - v) < Math.abs(best - v) ? q : best), values[0]);
}
export const nearestQuality = (v: number) => nearestOf(UP_QUALITIES.map((q) => q.value), v);

// Débruitage (modèle « Réel léger », 0..1) en paliers nommés.
export const UP_DENOISE: { value: number; label: string }[] = [
  { value: 0, label: "Aucun" },
  { value: 0.25, label: "Léger" },
  { value: 0.5, label: "Moyen" },
  { value: 0.75, label: "Fort" },
  { value: 1, label: "Maximum" },
];
export const nearestDenoise = (v: number) => nearestOf(UP_DENOISE.map((d) => d.value), v);

// Grain de débanding Turbo (0..16) en paliers nommés.
export const UP_GRAINS: { value: number; label: string }[] = [
  { value: 0, label: "Aucun" },
  { value: 4, label: "Léger" },
  { value: 8, label: "Moyen" },
  { value: 16, label: "Fort" },
];
export const nearestGrain = (v: number) => nearestOf(UP_GRAINS.map((g) => g.value), v);

// Audio : copier tel quel, réencoder (aac/ac3/flac/pcm), ou aucun.
export const UP_AUDIO: { id: AudioMode; label: string }[] = [
  { id: "copy", label: "Copier" },
  { id: "aac", label: "AAC" },
  { id: "ac3", label: "AC3" },
  { id: "flac", label: "FLAC" },
  { id: "pcm", label: "PCM" },
  { id: "none", label: "Aucun" },
];

// Débit (kbps) pour les codecs audio à perte (aac/ac3).
export const UP_ABR: number[] = [128, 192, 256, 320];
export const LOSSY_AUDIO = new Set<AudioMode>(["aac", "ac3"]);

// Tile : 0 = auto. Valeurs explicites pour borner la VRAM (anti-OOM en 4K).
export const UP_TILES: { value: number; label: string }[] = [
  { value: 0, label: "Auto" },
  { value: 256, label: "256" },
  { value: 512, label: "512" },
  { value: 1024, label: "1024" },
];

// tile_pad : recouvrement entre tuiles (cache les coutures quand tile > 0). Défaut RealESRGAN = 10.
export const UP_TILEPAD: number[] = [0, 10, 16, 24, 32];
// pre_pad : padding de bord avant inférence (réduit les artefacts sur les bords). Défaut = 0.
export const UP_PREPAD: number[] = [0, 10, 16, 24];
export const UP_CLEANUP: { value: number; label: string }[] = [
  { value: 0, label: "Aucun" },
  { value: 0.25, label: "Léger" },
  { value: 0.5, label: "Moyen" },
  { value: 0.75, label: "Fort" },
  { value: 1, label: "Maximum" },
];

export type UpScope = "whole" | "range" | "scenes";

export interface UpSource {
  name: string;
  path: string;
  in?: number;   // plan d'une timeline : portion source (secondes). Absent = fichier entier.
  out?: number;
  // Identité STABLE de l'entrée du bac (posée à l'ajout, survit au rognage). Deux plans du même
  // fichier = uids distincts → les effets keyés sur uid rechargent bien l'aperçu au changement de plan.
  uid?: string;
}

export interface UpSettings extends ProcessExportSettings {
  mode: "upscale" | "restore";
  engine: UpEngine;  // "ia" (Real-ESRGAN) ou "turbo" (shader GLSL libplacebo)
  shader: ShaderModel;  // shader du moteur Turbo
  tDeband: TurboDeband;  // Turbo : anti-aplats (deband)
  tGrain: number;        // Turbo : grain de débanding (0..16)
  tSharp: TurboSharp;    // Turbo : noyau de redimensionnement
  tSigmoid: boolean;     // Turbo : anti-ringing (sigmoïde)
  tDither: boolean;      // Turbo : tramage (anti-banding 8-bit)
  tParallel: boolean;    // Turbo : plusieurs exports shader simultanés
  tConcurrency: 2 | 3 | 4;
  rtxQuality: 1 | 2 | 3 | 4;  // RTX : qualité VSR du SDK
  rtxHdr: boolean;            // RTX : TrueHDR (SDR → HDR10)
  rtxHdrContrast: number;
  rtxHdrSaturation: number;
  rtxHdrMidGray: number;
  rtxHdrNits: number;         // luminance crête du master HDR
  model: UpscaleModel;
  scale: 1 | 2 | 4;
  codec: UpscaleCodec;
  denoise: number;   // 0..1
  tile: number;
  tilePad: number;   // recouvrement tuiles (tile_pad)
  prePad: number;    // padding bord (pre_pad)
  fp32: boolean;
  cleanupNoise: number; // 0..1, filtre bilatéral post-upscale
  cleanupEdges: number; // 0..1, réduction des halos/ringing autour des contours
  quality: number;   // CRF x264/x265
  preset: string;    // veryfast..slow
  bitDepth: 8 | 10;  // dérivé du profil (compat chemins legacy) — plus de toggle dédié
  profile: string;   // profil codec réel (-profile:v) : main/high/high10/high422… selon le codec
  audio: AudioMode;
  abr: number;       // débit audio kbps
  audioTrack: number;
}

export const DEFAULT_SETTINGS: UpSettings = {
  ...DEFAULT_PROCESS_EXPORT,
  mode: "upscale",
  engine: "ia",
  shader: "artcnn_c4f32",
  tDeband: "light",
  tGrain: 4,
  tSharp: "sharp",
  tSigmoid: true,
  tDither: true,
  tParallel: false,
  tConcurrency: 2,
  rtxQuality: 4,
  rtxHdr: false,         // un upscale ne change pas la colorimétrie sans qu'on le demande
  rtxHdrContrast: 125,   // valeurs par défaut du RTX Video SDK
  rtxHdrSaturation: 100,
  rtxHdrMidGray: 25,
  rtxHdrNits: 1000,
  model: "anime",
  scale: 2,
  codec: "hevc_nvenc",   // choix GPU auto (NVENC/QSV/AMF), avec repli x265 CPU
  denoise: 0.5,
  tile: 0,               // Auto = inférence plein cadre (1 passe GPU, le plus rapide) ; repli tuilé sur OOM
  tilePad: 10,
  prePad: 0,
  fp32: false,
  cleanupNoise: 0,
  cleanupEdges: 0,
  quality: 18,           // palier « Diffusion HQ » (UP_QUALITIES)
  preset: "slow",        // qualité élevée ; mappée selon l'encodeur matériel retenu
  bitDepth: 8,
  profile: "main",       // HEVC · GPU par défaut → Main 8-bit 4:2:0
  audio: "copy",
  abr: 192,
  audioTrack: -1,
};
