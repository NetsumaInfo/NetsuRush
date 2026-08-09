// Panneau d'inspection flottant de l'item sélectionné. Selon le type :
//  - média (image/vidéo/YouTube) : miroir H/V, rogner, portée de boucle, plan, supprimer ;
//  - texte : police, taille, gras/italique/souligné, alignement, couleur, surlignage, plan, supprimer ;
//  - cadre : titre + couleurs + mode de remplissage, plan, supprimer.
// Masqué pendant l'édition inline d'une note (libère l'espace). Multi-sélection (≥2) → arrangement.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FlipHorizontal, FlipVertical, Trash2, BringToFront, SendToBack, Crop, Download, AppWindow, Wand2, Undo2, Film } from "lucide-react";
import { nr } from "@/lib/bridge";
import { Separator } from "@/components/ui/separator";
import { useBoard } from "./useReferenceBoard";
import { IconToggle, IconAction } from "./inspectorControls";
import { TrimControls, TextControls, FrameControls, ArrangeBar, PlayModeControls, EmbedControls } from "./inspectorPanels";
import { displaySrc, probeImage, youtubeId, isRemoteRef } from "./referenceShared";
import { convertToEmbed, downloadMediaFromEmbed, downloadYoutube } from "./boardMediaActions";
import { quickUpscale } from "./boardUpscale";
import { UpscaleItemDialog } from "./UpscaleItemDialog";
import { iconForLink } from "./brandIcons";

// Cadence supposée d'une source en mode « même que la vidéo » (la vraie vient du core, après coup) :
// haute exprès, l'avertissement « vidéo longue » doit se déclencher plutôt trop tôt que trop tard.
const ASSUMED_SOURCE_FPS = 30;

export function Inspector() {
  const { t } = useTranslation("reference");
  const selectedId = useBoard((s) => s.selectedId);
  const count = useBoard((s) => s.selectedIds.length);
  const editingId = useBoard((s) => s.editingId);
  const item = useBoard((s) => s.items.find((i) => i.id === s.selectedId) ?? null);
  const patchItem = useBoard((s) => s.patchItem);
  const removeItem = useBoard((s) => s.removeItem);
  const bringToFront = useBoard((s) => s.bringToFront);
  const sendToBack = useBoard((s) => s.sendToBack);
  const setCropping = useBoard((s) => s.setCropping);
  const setNotice = useBoard((s) => s.setNotice);
  const addSequenceFrom = useBoard((s) => s.addSequenceFrom);
  const prefs = useBoard((s) => s.prefs);
  const [upOpen, setUpOpen] = useState(false);

  if (count >= 2) {
    return (
      <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
        <div className="flex w-max max-w-[96vw] items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur">
          <ArrangeBar count={count} />
        </div>
      </div>
    );
  }

  if (!selectedId || count !== 1 || !item) return null;
  // Note en cours d'édition : on GARDE la barre de style de texte accessible (changer police/taille/
  // couleur sans quitter la saisie). Pour les autres types, rien à éditer inline →
  // l'inspecteur masque la place. Le focus de la textarea est préservé via `data-note-toolbar`.
  if (editingId === item.id && item.kind !== "text") return null;
  // Séquence : barre dédiée (SequencePlayer) + actions génériques au clic droit → pas d'inspecteur ici.
  if (item.kind === "sequence") return null;
  const isText = item.kind === "text";
  const isFrame = item.kind === "frame";
  const isMedia = item.kind === "image" || item.kind === "video" || item.kind === "youtube" || item.kind === "embed";
  const trimmable = item.kind === "video" || item.kind === "youtube";
  const croppable = item.kind === "image" || item.kind === "video";
  // Upscalable = image/vidéo. Un média DISTANT/extrait (ref http, ex. vidéo tirée d'un post) est
  // accepté : la popup résout d'abord un fichier local (resolveMedia/extractMedia) avant d'upscaler.
  // Seuls data:/blob: (non résolubles côté serveur) sont exclus. YouTube/embed = autres kinds.
  const upscalable = (item.kind === "image" || item.kind === "video") && !/^(data:|blob:)/i.test(item.ref);
  // Extractible en frames = vidéo à FICHIER local (décomposée en images → item séquence).
  const framesExtractable = item.kind === "video" && !isRemoteRef(item.ref);
  // Média extrait d'un post (rebasculable en carte embed) ; lien à ouvrir dans le navigateur.
  const extracted = (item.kind === "image" || item.kind === "video") && !!item.sourceUrl;
  const linkUrl =
    item.kind === "youtube" ? `https://www.youtube.com/watch?v=${item.ref}`
    : item.kind === "embed" ? item.ref
    : item.sourceUrl || null;

  // Décompose la vidéo en frames d'aperçu sur la PLAGE DE BOUCLE [in, out] (sinon vidéo entière), élargie
  // de la MARGE des Paramètres (garde quelques secondes autour pour réajuster). Cadence/qualité/plafond
  // viennent aussi des Paramètres. Crée une séquence en place, ratio ajusté. Prévient avant si trop long.
  const extractFrames = async () => {
    const { seqFps: fps, seqMaxFrames: max, seqHeight: height, seqMarginSec: margin } = prefs;
    // Cadence « source » : la vraie valeur n'est connue qu'au retour du core → estimation prudente
    // (cadence courante haute) pour l'avertissement « vidéo trop longue » avant lancement.
    const estFps = fps > 0 ? fps : ASSUMED_SOURCE_FPS;
    const tin = item.trimIn && item.trimIn > 0 ? item.trimIn : 0;
    const tout = item.trimOut != null && item.trimOut > tin ? item.trimOut : 0;
    const inSec = tout > 0 ? Math.max(0, tin - margin) : undefined;
    const outSec = tout > 0 ? tout + margin : undefined;
    const range = inSec != null && outSec != null ? outSec - inSec : item.dur ?? 0;
    const long = range === 0 || range * estFps > max;
    setNotice({
      kind: "ok",
      sticky: true,
      text: long
        ? t("inspector.longVideo", { max })
        : t("inspector.extractingFrames"),
    });
    const r = await nr.reference?.extractFrames?.({ path: item.ref, fps, max, height, in: inSec, out: outSec });
    if (r?.ok && r.frames?.length) {
      const nat = await probeImage(displaySrc("image", r.frames[0]));
      addSequenceFrom(item.id, r.frames, nat.w && nat.h ? { w: nat.w, h: nat.h } : undefined, r.fps || estFps);
      setNotice({ kind: "ok", text: t("inspector.sequenceCreated", { count: r.frames.length }) });
    } else {
      setNotice({ kind: "error", text: r?.error ? t("notice.failedWith", { error: r.error }) : t("notice.extractFailed") });
    }
  };

  return (
    <div data-note-toolbar className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
      <div className="flex w-max max-w-[96vw] items-center gap-1 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur">
        {/* Contrôles propres au type */}
        {isMedia && (
          <>
            <IconToggle on={item.flipH} label={t("actions.flipH")} onClick={() => patchItem(item.id, { flipH: !item.flipH })}>
              <FlipHorizontal />
            </IconToggle>
            <IconToggle on={item.flipV} label={t("actions.flipV")} onClick={() => patchItem(item.id, { flipV: !item.flipV })}>
              <FlipVertical />
            </IconToggle>
          </>
        )}
        {isText && <TextControls item={item} />}
        {isFrame && <FrameControls item={item} />}
        {trimmable && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <PlayModeControls item={item} />
            <Separator orientation="vertical" className="h-6" />
            <TrimControls item={item} />
          </>
        )}
        {/* Ce que le partage gardera de CE média (le board a son défaut, l'item peut le surcharger). */}
        {isMedia && (
          <>
            <Separator orientation="vertical" className="h-6" />
            <EmbedControls item={item} />
          </>
        )}

        {/* Lien d'origine : ouvrir dans le navigateur + bascule média ↔ carte embed */}
        {(linkUrl || item.kind === "embed" || extracted) && <Separator orientation="vertical" className="h-6" />}
        {linkUrl && (() => {
          const LinkIcon = iconForLink(linkUrl);
          return (
            <IconAction label={t("actions.openLink")} onClick={() => void nr.openExternal(linkUrl)}>
              <LinkIcon />
            </IconAction>
          );
        })()}
        {/* Fichier déjà téléchargé et gardé lors d'un passage en embed → le bouton le REND, il ne
            retélécharge pas : l'intitulé le dit pour qu'on n'hésite pas à faire l'aller-retour. */}
        {item.kind === "embed" && (
          <IconAction
            label={item.localMedia ? t("actions.restoreDownload") : t("actions.download")}
            onClick={() => void downloadMediaFromEmbed(item.id)}
          >
            <Download />
          </IconAction>
        )}
        {item.kind === "youtube" && (
          <IconAction
            label={item.localMedia ? t("actions.restoreDownload") : t("actions.download")}
            onClick={() => void downloadYoutube(item.id)}
          >
            <Download />
          </IconAction>
        )}
        {extracted && (
          <IconAction
            label={item.sourceUrl && youtubeId(item.sourceUrl) ? t("inspector.ytPlayer") : t("inspector.anchoredCard")}
            onClick={() => convertToEmbed(item.id)}
          >
            <AppWindow />
          </IconAction>
        )}

        {/* Disposition */}
        <Separator orientation="vertical" className="h-6" />
        {croppable && (
          <IconAction label={t("actions.crop")} active={!!item.crop} onClick={() => setCropping(item.id)}>
            <Crop />
          </IconAction>
        )}
        {/* Upscale : « rapide » lance directement avec les préréglages des Paramètres du board,
            sinon la popup laisse choisir modèle/échelle et voir un aperçu. */}
        {upscalable && (
          <IconAction
            label={prefs.upQuick ? t("inspector.upscaleQuick") : t("inspector.upscale")}
            onClick={() => (prefs.upQuick ? void quickUpscale(item.id) : setUpOpen(true))}
          >
            <Wand2 />
          </IconAction>
        )}
        {framesExtractable && (
          <IconAction label={t("inspector.extractFrames")} onClick={() => void extractFrames()}>
            <Film />
          </IconAction>
        )}
        {item.prevMedia && (
          <IconAction
            label={t("inspector.undoUpscale")}
            onClick={() => {
              const pm = item.prevMedia!;
              const upscaled = item.ref; // fichier upscalé (asset app) → nettoyé après restauration
              patchItem(item.id, {
                ref: pm.ref, src: pm.src, trimIn: pm.trimIn, trimOut: pm.trimOut, crop: pm.crop,
                prevMedia: undefined,
              });
              void nr.reference?.dropAsset(upscaled);
            }}
          >
            <Undo2 />
          </IconAction>
        )}
        <IconAction label={t("actions.bringToFront")} onClick={() => bringToFront(item.id)}><BringToFront /></IconAction>
        <IconAction label={t("actions.sendToBack")} onClick={() => sendToBack(item.id)}><SendToBack /></IconAction>
        <IconAction label={t("common:action.delete")} onClick={() => removeItem(item.id)}>
          <Trash2 className="text-destructive" />
        </IconAction>
      </div>
      {upscalable && <UpscaleItemDialog item={item} open={upOpen} onOpenChange={setUpOpen} />}
    </div>
  );
}
