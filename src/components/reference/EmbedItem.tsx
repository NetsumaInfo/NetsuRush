// Item embed (carte ancrée d'un post / lecteur vidéo en ligne) : iframe nue dont le src porte les
// params du provider (cf. parseVideoEmbed). Deux soucis réglés ici :
//  1. Scrollbar interne moche + contenu coupé des cartes SOCIALES (Twitter/Insta) : leur hauteur
//     dépend du contenu et n'est pas connue à l'avance. → on ÉCOUTE le message postMessage de
//     redimensionnement (Twitter & Instagram en envoient un) et on ajuste la hauteur de l'item au
//     contenu, pile. Les autres providers : ratio libre côté redimensionnement + scrolling caché.
//  2. Drag du board volé par l'iframe : wrapper en pointer-events:none.

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Snowflake } from "lucide-react";
import { cn } from "@/lib/utils";
import { type BoardItem, parseVideoEmbed } from "./referenceShared";
import { useBoard } from "./useReferenceBoard";

// Lit une hauteur de contenu depuis un message d'iframe (formats Twitter et Instagram).
function readEmbedHeight(data: unknown): number {
  if (data && typeof data === "object") {
    // Twitter/X : { "twttr.embed": { method:"twttr.private.resize", params:[{ width, height }] } }
    const tw = (data as Record<string, { params?: { height?: number }[] }>)["twttr.embed"];
    const h = tw?.params?.[0]?.height;
    if (typeof h === "number") return h;
  }
  if (typeof data === "string") {
    // Instagram : '{"type":"MEASURE","details":{"height":...}}'
    try {
      const j = JSON.parse(data);
      if (j?.type === "MEASURE" && typeof j.details?.height === "number") return j.details.height;
    } catch { /* pas du JSON Instagram */ }
  }
  return 0;
}

export function EmbedItem({ item, interactive }: { item: BoardItem; interactive?: boolean }) {
  const { t } = useTranslation("reference");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const patchItem = useBoard((s) => s.patchItem);
  const frozen = useBoard((s) => s.frozen);
  const provider = parseVideoEmbed(item.ref, true)?.provider ?? "generic";
  const autoHeight = provider === "twitter" || provider === "instagram";
  // hauteur courante lue par le handler sans réabonner à chaque changement.
  const hRef = useRef(item.h);
  useEffect(() => { hRef.current = item.h; }, [item.h]);

  useEffect(() => {
    if (!autoHeight) return;
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return; // ne réagit qu'à NOTRE iframe
      const h = Math.round(readEmbedHeight(e.data));
      if (h > 40 && Math.abs((hRef.current || 0) - h) > 2) patchItem(item.id, { h }, false);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [autoHeight, item.id, patchItem]);

  // « Tout figer » : l'iframe est DÉMONTÉE — c'était le seul média que le gel n'atteignait pas, un
  // lecteur Vimeo/Twitch continuait de décoder sous un board censé être à l'arrêt. Masquer ne suffit
  // pas (une iframe en display:none tourne encore) ; au dégel elle se recharge, prix assumé d'un
  // gel explicite.
  if (frozen) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-xl bg-[var(--color-surface)] text-muted-foreground">
        <Snowflake className="size-6" strokeWidth={1.5} />
        <span className="max-w-[85%] truncate text-xs font-medium">{item.title ?? t("embed.frozen")}</span>
        <span className="text-[10px]">{t("embed.frozen")}</span>
      </div>
    );
  }
  return (
    <div className={cn("block h-full w-full overflow-hidden rounded-xl bg-[var(--color-surface)]", interactive ? "pointer-events-auto" : "pointer-events-none")}>
      <iframe
        ref={frameRef}
        src={item.src}
        title={item.title ?? t("embed.onlineMedia")}
        scrolling="no"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        allowFullScreen
        className="block h-full w-full border-0"
      />
    </div>
  );
}
