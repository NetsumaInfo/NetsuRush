// Upscale d'un item média du board. Deux chemins pour un même travail :
//  - la popup (UpscaleItemDialog) quand on veut choisir modèle/échelle et voir un aperçu ;
//  - le chemin RAPIDE (`quickUpscale`) quand les Paramètres du board fixent déjà les réglages :
//    un seul clic, aucune boîte de dialogue, progression en notice.
// Les deux partagent la résolution du fichier local et l'application non destructive du résultat.

import { nr } from "@/lib/bridge";
import type { ShaderModel, UpscaleModel } from "@/lib/bridge";
import i18n from "@/i18n";
import { boardUpEngine, isRtxShader, UP_MODELS } from "@/components/upscale/upscaleShared";
import { displaySrc, isRemoteRef, type BoardItem } from "./referenceShared";
import type { BoardPrefs } from "./boardPrefs";
import { useBoard } from "./useReferenceBoard";

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(`reference:${key}`, opts);

// Réglages effectifs d'un upscale : le sélecteur unique porte un id IA OU un id de shader Turbo.
// Les shaders valent pour la vidéo ET l'image fixe ; seul RTX VSR reste vidéo (son CLI ne traite que
// des fichiers entiers), et un GIF animé retombe côté core sur le moteur IA, seul à savoir
// réencoder toutes ses frames.
export interface UpscaleChoice {
  engine: "ia" | "turbo";
  model: UpscaleModel;
  shader: ShaderModel;
  scale: 1 | 2 | 4;
  denoise?: number;
}

export function upscaleChoiceFrom(selection: string, prefs: BoardPrefs, isVideo: boolean, denoise: number, scale: 1 | 2 | 4): UpscaleChoice {
  const turbo = boardUpEngine(selection) === "turbo" && (isVideo || !isRtxShader(selection as ShaderModel));
  const model = (turbo ? prefs.upModel : selection) as UpscaleModel;
  // Le débruitage n'existe que sur les modèles IA qui l'exposent : l'envoyer ailleurs n'a pas de sens.
  const denoisable = !turbo && !!UP_MODELS.find((m) => m.id === model)?.denoise;
  return {
    engine: turbo ? "turbo" : "ia",
    model,
    shader: (turbo ? selection : prefs.upShader) as ShaderModel,
    scale,
    denoise: denoisable ? denoise : undefined,
  };
}

// Le moteur Turbo GLSL sait rendre une image de test ; RTX VSR passe par un CLI qui ne traite que des
// fichiers vidéo entiers → pas d'aperçu pour lui (et pour lui seul).
export const canPreviewUpscale = (choice: UpscaleChoice) =>
  choice.engine === "ia" || !isRtxShader(choice.shader);

// L'upscale exige un fichier LOCAL. Un média distant/extrait (ref http) est d'abord résolu
// (resolveMedia, repli extractMedia). Un ref local est renvoyé tel quel.
export async function ensureLocalMedia(ref: string): Promise<string | null> {
  if (!isRemoteRef(ref)) return ref;
  const api = nr.reference;
  if (!api) return null;
  const r = await api.resolveMedia?.(ref);
  if (r?.ok && r.path) return r.path;
  const e = await api.extractMedia?.(ref);
  return e?.ok && e.items?.length ? e.items[0].path : null;
}

// Remplace le média de l'item par le fichier upscalé. Non destructif : l'ancien part dans `prevMedia`
// (bouton « revenir en arrière » de l'inspecteur). Rognage/portée retombent (dimensions changées).
export function applyUpscaled(item: BoardItem, path: string) {
  useBoard.getState().patchItem(item.id, {
    ref: path,
    src: displaySrc(item.kind, path),
    crop: undefined,
    trimIn: undefined,
    trimOut: undefined,
    prevMedia: { ref: item.ref, src: item.src, trimIn: item.trimIn, trimOut: item.trimOut, crop: item.crop },
  });
}

// Upscale « rapide » : les réglages viennent des Paramètres du board, rien à choisir. Progression en
// notice collante (l'utilisateur garde le board), erreurs remontées en notice rouge.
export async function quickUpscale(id: string): Promise<boolean> {
  const st = useBoard.getState();
  const item = st.items.find((i) => i.id === id);
  const api = nr.reference;
  if (!item) return false;
  if (!api) { st.setNotice({ kind: "error", text: tr("upscale.moduleUnavailable") }); return false; }
  const isVideo = item.kind === "video";
  const prefs = st.prefs;
  const selection = prefs.upEngine === "turbo" ? prefs.upShader : prefs.upModel;
  const choice = upscaleChoiceFrom(selection, prefs, isVideo, prefs.upDenoise, prefs.upScale);

  st.setNotice({ kind: "ok", sticky: true, text: tr("upscale.upscaling") });
  const offProgress = isVideo
    ? nr.onUpscaleProgress((p) => {
        if (p.pct != null) st.setNotice({ kind: "ok", sticky: true, text: tr("upscale.upscalingPct", { pct: Math.round(p.pct) }) });
      })
    : null;
  try {
    const input = await ensureLocalMedia(item.ref);
    if (!input) { st.setNotice({ kind: "error", text: tr("upscale.remoteFail") }); return false; }
    const r = await api.upscaleItem({
      path: input, kind: isVideo ? "video" : "image",
      in: item.trimIn, out: item.trimOut,
      engine: choice.engine, model: choice.model, shader: choice.shader, scale: choice.scale, denoise: choice.denoise,
    });
    if (!r.ok || !r.path) {
      st.setNotice({ kind: "error", text: r.error ? tr("notice.failedWith", { error: r.error }) : tr("upscale.upscaleFail") });
      return false;
    }
    applyUpscaled(item, r.path);
    st.setNotice({ kind: "ok", text: tr("upscale.upscaled") });
    return true;
  } catch (e) {
    st.setNotice({ kind: "error", text: tr("notice.failedWith", { error: String(e) }) });
    return false;
  } finally {
    offProgress?.();
  }
}
