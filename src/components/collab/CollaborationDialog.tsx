// Share: create a shared project on a document and invite people to it (`docs/collab.md`).
//
// Only someone from the friend list can be invited. Discord's friend list is unreachable without
// its Social SDK and Discord's approval, so the list built in Settings ▸ Account ▸ Sharing IS the
// address book — and it also keeps a project id from being handed to strangers.
//
// The dialog knows nothing about what is being shared. The host module passes the project it is on
// (if any) and an `onShare` that binds its own document and publishes it; everything else — roster,
// roles, invitations, rotation, stale heads, leaving and deleting — is the same for every surface.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConvexAuth, useQuery } from "convex/react";
import { AlertTriangle, LogOut, Trash2, UserRound, Users } from "lucide-react";
import { api } from "@/lib/convexApi";
import {
  cancelInvite,
  collabErrorMessage,
  deleteProject,
  discardStaleHead,
  inviteMembers,
  leaveProject,
  projectStatus,
  removeMember,
  setMemberRole,
  type ProjectStatus,
} from "@/lib/collab/client";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { UnreadableMediaError } from "@/lib/collab/session";
import type { ProjectRole } from "@/lib/collab/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";

type Profile = { userId: string; handle: string; name: string; image: string | null };
type Social = { friends: Array<Profile & { since: number }> } | undefined;
type Project = {
  projectId: string;
  role: ProjectRole;
  rotationRequired: boolean;
  members: Array<Profile & { role: ProjectRole }>;
  pending: Array<Profile & { inviteId: string; role: "editor" | "viewer" }>;
};
type StaleHead = { headId: string; deviceId: string; bytes: number; updatedAt: number };

export type CollaborationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Project the host document is already on, or null when it is not shared yet. */
  projectId: string | null;
  /** Role the host knows, when it knows one; the roster answers otherwise. */
  role?: ProjectRole | null;
  /**
   * Publishes the host document and returns the project it created. It owns everything specific:
   * healing its media, adopting the document into a library, binding the project to it and rolling
   * all of that back when the publication fails.
   */
  onShare: () => Promise<{ projectId: string }>;
  /**
   * i18n key (namespace `collab`) explaining why this document cannot be shared right now, or null.
   * A document that was never saved is the usual case: there is nothing to bind a project to.
   */
  blockerKey?: string | null;
  /** A note under the button — "this file will be adopted into the library", and the like. */
  noticeKey?: string | null;
  /** The project is gone: the host must leave the document rather than keep projecting it. */
  onRemoved?: () => void;
  /**
   * Does the dialog own the editor/viewer switch? A surface whose permission is richer than the two
   * roles - a collection pairs the role with a removal delegation - sets its own, elsewhere, and
   * turns this off so there are never two places to set the same thing. Removing a member and
   * cancelling an invitation stay here either way.
   */
  memberRoles?: boolean;
};

function Avatar({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" className="size-7 rounded-full object-cover" referrerPolicy="no-referrer" />
  ) : (
    <div className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <UserRound className="size-4" />
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function CollaborationDialog({
  open,
  onOpenChange,
  projectId,
  role = null,
  onShare,
  blockerKey = null,
  noticeKey = null,
  onRemoved,
  memberRoles = true,
}: CollaborationDialogProps) {
  const { t } = useTranslation(["collab", "common"]);
  const { isAuthenticated } = useConvexAuth();
  const [queryNow, setQueryNow] = useState(() => Date.now());
  useEffect(() => {
    if (open) setQueryNow(Date.now());
  }, [open]);
  const social = useQuery(api.social.listSocial, open ? {} : "skip") as Social;
  const current = useQuery(
    api.projects.getProjectDetails,
    open && projectId ? { projectId, now: queryNow } : "skip",
  ) as Project | null | undefined;
  const effectiveRole = role ?? current?.role ?? null;
  const staleHeads = useQuery(
    api.heads.listStaleHeads,
    open && projectId && effectiveRole === "owner" ? { projectId, now: queryNow } : "skip",
  ) as StaleHead[] | undefined;

  // The document syncs by itself — queued edits leave the moment a peer or the relay is reachable.
  // This line only makes that visible: what is waiting, and that nobody has to send anything.
  const [sync, setSync] = useState<ProjectStatus | null>(null);
  useEffect(() => {
    if (!open || !projectId) {
      setSync(null);
      return;
    }
    let cancelled = false;
    const read = () => {
      void projectStatus(projectId)
        .then((status) => { if (!cancelled) setSync(status); })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, projectId]);

  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [confirmLifecycle, setConfirmLifecycle] = useState<"leave" | "delete" | null>(null);
  const [confirmStaleHead, setConfirmStaleHead] = useState<string | null>(null);

  function toggle(userId: string) {
    setPicked((current) =>
      current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId],
    );
  }

  function countInvited(results: Array<{ status: string }>) {
    setInvited(results.filter((entry) =>
      entry.status === "invited" || entry.status === "refreshed").length);
  }

  async function submit() {
    if (busy || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      if (blockerKey) throw new Error(t(blockerKey));
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("signedOut"));
      if (projectId) {
        const { results } = await inviteMembers(projectId, picked, inviteRole);
        countInvited(results);
      } else {
        const created = await onShare();
        // The document IS shared from here on. An invitation that fails is retried on the next
        // open of this dialog; undoing the project underneath it would throw away a published one.
        const { results } = await inviteMembers(created.projectId, picked, inviteRole);
        countInvited(results);
      }
      setPicked([]);
    } catch (err) {
      // Unreadable media after every automatic recovery: a wall of absolute paths and OS errors
      // says nothing actionable. Name the files instead; the host marks the missing pieces.
      if (err instanceof UnreadableMediaError) {
        const names = err.unresolved
          .slice(0, 3)
          .map((entry) => entry.ref.split(/[\\/]/).pop() || entry.ref)
          .join(" · ");
        setError(t("dialog.mediaMissing", { count: err.unresolved.length, names }));
      } else {
        setError(collabErrorMessage(err, t("dialog.failed")));
      }
    } finally {
      setBusy(false);
    }
  }

  async function memberAction(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("signedOut"));
      await action();
    } catch (err) {
      setError(collabErrorMessage(err, t("dialog.failed")));
    } finally {
      setBusy(false);
    }
  }

  async function finishLifecycle() {
    if (!projectId || !confirmLifecycle) return;
    await memberAction(async () => {
      if (confirmLifecycle === "delete") await deleteProject(projectId);
      else await leaveProject(projectId);
      onRemoved?.();
      setConfirmLifecycle(null);
      onOpenChange(false);
    });
  }

  async function finishStaleHeadDiscard() {
    if (!confirmStaleHead) return;
    await memberAction(async () => {
      await discardStaleHead(confirmStaleHead);
      setConfirmStaleHead(null);
    });
  }

  const friends = social?.friends ?? [];
  const unavailable = new Set([
    ...(current?.members.map((member) => member.userId) ?? []),
    ...(current?.pending.map((member) => member.userId) ?? []),
  ]);
  const eligibleFriends = friends.filter((friend) => !unavailable.has(friend.userId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4" /> {t("dialog.title")}
          </DialogTitle>
          <DialogDescription>{t("dialog.subtitle")}</DialogDescription>
        </DialogHeader>

        {confirmLifecycle ? (
          <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
            <p className="text-sm font-medium">{t(`lifecycle.${confirmLifecycle}Title`)}</p>
            <p className="text-xs text-muted-foreground">
              {t(`lifecycle.${confirmLifecycle}Warning`)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmLifecycle(null)}>
                {t("common:action.cancel")}
              </Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={() => void finishLifecycle()}>
                {t(`lifecycle.${confirmLifecycle}`)}
              </Button>
            </div>
          </div>
        ) : confirmStaleHead ? (
          <div className="space-y-3 rounded-lg border border-destructive/40 p-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4" /> {t("staleHead.confirmTitle")}
            </p>
            <p className="text-xs text-muted-foreground">{t("staleHead.confirmWarning")}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmStaleHead(null)}>
                {t("common:action.cancel")}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void finishStaleHeadDiscard()}
              >
                {t("staleHead.discard")}
              </Button>
            </div>
          </div>
        ) : current ? (
          <div className="space-y-3">
            {sync && (
              <p
                className={
                  sync.offlineQueued
                    ? "rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
                    : "text-xs text-muted-foreground"
                }
              >
                {sync.offlineQueued ? t("sync.queued") : t("sync.upToDate")}
                {" · "}
                {t("sync.peers", { count: sync.peerCandidates })}
              </p>
            )}
            {current.rotationRequired && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                {t("rotationPending")}
              </p>
            )}
            {effectiveRole === "owner" && (staleHeads?.length ?? 0) > 0 && (
              <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
                <p className="flex items-center gap-2 font-medium">
                  <AlertTriangle className="size-3.5" /> {t("staleHead.title")}
                </p>
                <p className="text-muted-foreground">{t("staleHead.warning")}</p>
                {staleHeads!.map((head) => (
                  <div key={head.headId} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-[11px]">{head.deviceId.slice(0, 12)}…</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("staleHead.detail", {
                          days: Math.max(30, Math.floor((Date.now() - head.updatedAt) / 86_400_000)),
                          size: formatBytes(head.bytes),
                        })}
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmStaleHead(head.headId)}
                    >
                      {t("staleHead.discard")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div className="divide-y divide-border rounded-lg border border-border px-3">
              {current.members.map((member) => (
                <div key={member.userId} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{member.name || member.handle}</span>
                  {effectiveRole === "owner" && member.role !== "owner" ? (
                    <>
                      {memberRoles ? (
                        <>
                          <Button
                            size="sm"
                            variant={member.role === "editor" ? "default" : "outline"}
                            disabled={busy}
                            onClick={() => void memberAction(() => setMemberRole(projectId!, member.userId, "editor"))}
                          >
                            {t("projects.role.editor")}
                          </Button>
                          <Button
                            size="sm"
                            variant={member.role === "viewer" ? "default" : "outline"}
                            disabled={busy}
                            onClick={() => void memberAction(() => setMemberRole(projectId!, member.userId, "viewer"))}
                          >
                            {t("projects.role.viewer")}
                          </Button>
                        </>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">{t(`projects.role.${member.role}`)}</span>
                      )}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("members.remove")}
                        onClick={() => void memberAction(() => removeMember(projectId!, member.userId))}
                      >
                        <Trash2 />
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`projects.role.${member.role}`)}</span>
                  )}
                </div>
              ))}
              {current.pending.map((member) => (
                <div key={member.inviteId} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{member.name || member.handle}</span>
                  <span className="text-xs text-muted-foreground">{t("members.pending")}</span>
                  {effectiveRole === "owner" && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("members.cancelInvite")}
                      onClick={() => void memberAction(() => cancelInvite(member.inviteId))}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            {effectiveRole === "owner" && eligibleFriends.length > 0 && (
              <div className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">
                {eligibleFriends.map((friend) => (
                  <label key={friend.userId} className="flex cursor-pointer items-center gap-3 py-2">
                    <Checkbox
                      checked={picked.includes(friend.userId)}
                      onCheckedChange={() => toggle(friend.userId)}
                    />
                    <Avatar url={friend.image} />
                    <span className="min-w-0 flex-1 truncate text-sm">{friend.name || friend.handle}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              {effectiveRole === "owner" ? (
                <Button variant="destructive" size="sm" onClick={() => setConfirmLifecycle("delete")}>
                  <Trash2 className="size-3.5" /> {t("lifecycle.delete")}
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setConfirmLifecycle("leave")}>
                  <LogOut className="size-3.5" /> {t("lifecycle.leave")}
                </Button>
              )}
            </div>
          </div>
        ) : !isAuthenticated ? (
          <p className="text-sm text-muted-foreground">{t("signedOut")}</p>
        ) : social === undefined ? (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        ) : !friends.length ? (
          <p className="text-sm text-muted-foreground">{t("dialog.noFriends")}</p>
        ) : (
          <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">
            {friends.map((friend) => (
              <label key={friend.userId} className="flex cursor-pointer items-center gap-3 py-2">
                <Checkbox
                  checked={picked.includes(friend.userId)}
                  onCheckedChange={() => toggle(friend.userId)}
                />
                <Avatar url={friend.image} />
                <span className="min-w-0 flex-1 truncate text-sm">{friend.name || friend.handle}</span>
              </label>
            ))}
          </div>
        )}

        {(!projectId || effectiveRole === "owner") && !confirmLifecycle && !confirmStaleHead && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={inviteRole === "editor" ? "default" : "outline"}
              onClick={() => setInviteRole("editor")}
            >
              {t("projects.role.editor")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={inviteRole === "viewer" ? "default" : "outline"}
              onClick={() => setInviteRole("viewer")}
            >
              {t("projects.role.viewer")}
            </Button>
          </div>
        )}

        {invited !== null && <p className="text-xs text-muted-foreground">{t("dialog.invited", { n: invited })}</p>}
        {blockerKey && <p className="text-xs text-destructive">{t(blockerKey)}</p>}
        {!blockerKey && !projectId && noticeKey && (
          <p className="text-xs text-muted-foreground">{t(noticeKey)}</p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">{t("dialog.notice")}</p>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("common:action.close")}
          </Button>
          <Button
            size="sm"
            disabled={
              busy || !!blockerKey || !picked.length
              || (!!projectId && effectiveRole !== "owner")
              || !!confirmLifecycle || !!confirmStaleHead
            }
            onClick={() => void submit()}
          >
            {busy ? <Spinner className="size-3.5" /> : <Users className="size-3.5" />}{" "}
            {t(projectId ? "dialog.invite" : "dialog.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
