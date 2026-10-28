import { useTranslation } from "react-i18next";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import type { CollectionCollaboration } from "@/lib/bridge";

/** True when the collection is bound to a shared project. */
export const isSharedCollection = (collaboration?: CollectionCollaboration | null) => !!collaboration?.projectId;

/**
 * Card marker for a shared collection. The tooltip says whether it is the owner's share or one
 * received read-only, using the role remembered with the local collection.
 */
export function SharedBadge({ collaboration }: { collaboration?: CollectionCollaboration | null }) {
  const { t } = useTranslation("collections");
  if (!isSharedCollection(collaboration)) return null;
  const readOnly = collaboration?.role === "viewer";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" aria-label={t(readOnly ? "share.badgeReadOnly" : "share.badge")} />}>
        <NetsuIcon name="collab" className="size-3 text-primary" />
      </TooltipTrigger>
      <TooltipContent>{t(readOnly ? "share.badgeReadOnly" : "share.badge")}</TooltipContent>
    </Tooltip>
  );
}
