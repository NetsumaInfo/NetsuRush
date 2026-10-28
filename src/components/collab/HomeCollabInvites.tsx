// Pending collaboration invitations on the Derush home: accepting a share should not require
// digging through Settings > Account. Each invitation is a small card - join, decline, or later
// (hidden until the next launch; it stays in Settings meanwhile).
//
// Mounted only when Convex is configured AND behind a lazy import: the convex/react chain must stay
// out of the startup bundle (cf. src/lib/convexEnv.ts). Joining goes through the surface registry,
// exactly like Settings > Account, so a module that shares appears here with no change.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/lib/convexApi";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { respondInvite } from "@/lib/collab/client";
import { collabErrorText } from "@/lib/collab/errors";
import { collabBindings, collabSurface } from "@/lib/collab/surfaces";
import { Button } from "@/components/ui/button";
import { NetsuIcon } from "@/components/ui/netsu-icon";
import { toast } from "@/components/ui/toast";

type Invite = {
  inviteId: string;
  projectId: string;
  role: string;
  surface: string;
  from: { userId: string; handle: string; name: string; image: string | null };
};

// "Later" lasts for the session; the invitation remains in Settings > Account.
const snoozed = new Set<string>();

export function HomeCollabInvites() {
  const { t } = useTranslation("collab");
  const { isAuthenticated } = useConvexAuth();
  const [now] = useState(() => Date.now());
  const invites = useQuery(api.projects.listInvites, isAuthenticated ? { now } : "skip") as Invite[] | undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const [, forceRender] = useState(0);

  async function answer(invite: Invite, accept: boolean) {
    if (busy) return;
    setBusy(invite.inviteId);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("device.unavailable"));
      const result = await respondInvite(invite.inviteId, accept);
      if (!accept || result.status !== "joined" || !result.projectId) return;
      // A project already bound keeps its document: a re-invitation must not mint a second copy.
      const existing = (await collabBindings()).get(result.projectId);
      const surface = collabSurface(invite.surface);
      if (existing) { surface?.open?.(existing); return; }
      if (!surface) return;
      const binding = await surface.adopt(result.projectId, invite.from.name || invite.from.handle || t("invites.shared"));
      surface.open?.(binding);
    } catch (error) {
      toast.error(collabErrorText(error, t("invites.failed")));
    } finally {
      setBusy(null);
    }
  }

  const visible = (invites ?? []).filter((invite) => !snoozed.has(invite.inviteId));
  if (!isAuthenticated || !visible.length) return null;

  return (
    // fixed: the home scrolls, an absolute card would anchor to the bottom of the scrolled content.
    <div className="fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2">
      {visible.map((invite) => (
        <div key={invite.inviteId}
          className="animate-in fade-in-0 slide-in-from-bottom-2 rounded-lg border border-border bg-popover p-3 shadow-lg shadow-black/30">
          <div className="flex items-center gap-2.5">
            {invite.from.image
              ? <img src={invite.from.image} alt="" referrerPolicy="no-referrer" className="size-8 rounded-full object-cover" />
              : <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <NetsuIcon name="account" className="size-4" />
              </div>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{invite.from.name || invite.from.handle}</p>
              <p className="truncate text-xs text-muted-foreground">{t("invites.body")}</p>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" disabled={busy === invite.inviteId}
              onClick={() => { snoozed.add(invite.inviteId); forceRender((n) => n + 1); }}>
              {t("invites.later")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === invite.inviteId} onClick={() => void answer(invite, false)}>
              <NetsuIcon name="close" className="size-3.5" /> {t("invites.decline")}
            </Button>
            <Button size="sm" disabled={busy === invite.inviteId} onClick={() => void answer(invite, true)}>
              <NetsuIcon name="check" className="size-3.5" /> {t("invites.join")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
