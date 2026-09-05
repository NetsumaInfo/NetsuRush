import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "convex/react";

import { api } from "@/lib/convexApi";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { isCollabProjectOpen } from "@/lib/collab/currentProject";
import { toast } from "@/components/ui/toast";

type ActivityNotice = {
  projectId: string;
  actors: number;
  mediaRequested: boolean;
  keyRequested: boolean;
  updatedAt: number;
};

/**
 * Surfaces the durable inbox when the app comes back online. The row stays visible in Account ▸
 * Sharing until explicitly dismissed; session storage only keeps a React remount from repeating
 * the same transient toast.
 */
export function CollaborationNotifications() {
  const { t } = useTranslation("collab");
  const notices = useQuery(api.heads.inbox) as ActivityNotice[] | undefined;

  useEffect(() => {
    if (!notices) return;
    for (const notice of notices) {
      const key = `nr-collab-notice:${notice.projectId}:${notice.updatedAt}`;
      if (notice.keyRequested && !sessionStorage.getItem(`${key}:key-refresh`)) {
        sessionStorage.setItem(`${key}:key-refresh`, "1");
        // A new member cannot decrypt anything until an existing writer wraps the current key for
        // their proved device. Refreshing the native session is what makes this device do it.
        void refreshNativeCollaborationAuth().catch(() => undefined);
      }
      // Someone looking at the document already sees the revision arrive. The durable row stays
      // available in settings, but a transient "while you were away" would be a lie.
      if (isCollabProjectOpen(notice.projectId)) continue;
      if (sessionStorage.getItem(key)) continue;
      sessionStorage.setItem(key, "1");
      toast.info(
        notice.keyRequested
          ? t("activity.key", { count: notice.actors })
          : notice.mediaRequested
            ? t("activity.media", { count: notice.actors })
            : t("activity.changed", { count: notice.actors }),
      );
    }
  }, [notices, t]);

  return null;
}
