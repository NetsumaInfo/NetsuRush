// Account ▸ Sharing: everything about collaboration that belongs to the ACCOUNT rather than to one
// document — this machine's device identity, the people it may share with, the invitations waiting
// for an answer, the projects it takes part in, and what happened while the app was closed.
//
// Nothing here knows what a project contains. Local documents are reached through the surface
// registry (`@/lib/collab/surfaces`), so a module that starts sharing appears in this list without
// a line changing here.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import {
  Check, ChevronDown, ChevronRight, Laptop, Trash2, UserPlus, UserRound, Users, X,
} from "lucide-react";
import { api } from "@/lib/convexApi";
import { convexConfigured } from "@/lib/convexEnv";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import {
  collabAvailable,
  collabErrorMessage,
  deviceIdentity,
  forgetDevice,
  deleteProject as deleteProjectNative,
  leaveProject as leaveProjectNative,
  respondInvite as respondInviteNative,
} from "@/lib/collab/client";
import { collabBindings, collabSurface, type CollabBinding } from "@/lib/collab/surfaces";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { SectionTitle } from "./rows";
import { uiLocale } from "@/lib/utils";

type AuthUser = { name?: string | null; image?: string | null } | null | undefined;
type Profile = {
  userId: string;
  handle: string;
  discordUsername?: string | null;
  name: string;
  image: string | null;
};
type Social = {
  self: Profile | null;
  friends: Array<Profile & { since: number }>;
  incoming: Array<Profile & { requestId: string }>;
  outgoing: Array<Profile & { requestId: string; pending?: boolean }>;
};
type ProjectSummary = {
  projectId: string;
  role: "owner" | "editor" | "viewer";
  isOwner: boolean;
  surface: string;
  createdAt: number;
  rotationRequired: boolean;
};
type Invite = {
  inviteId: string;
  projectId: string;
  role: string;
  surface: string;
  from: Profile;
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

function Row({ profile, children }: { profile: Profile; children?: React.ReactNode }) {
  const secondary =
    profile.discordUsername && profile.discordUsername !== profile.name
      ? profile.discordUsername
      : profile.handle && profile.handle !== profile.name
        ? profile.handle
        : null;
  return (
    <div className="flex items-center gap-3 py-2">
      <Avatar url={profile.image} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{profile.name || profile.handle}</p>
        {/* Discord pseudonym and NetsuRush handle are usually derived from the same name, so
            printing both showed it twice. Only the second is kept when it says something new. */}
        {secondary && <p className="truncate text-xs text-muted-foreground">@{secondary}</p>}
      </div>
      {children}
    </div>
  );
}

export function SharingSettings() {
  const { t } = useTranslation("collab");
  // Outside a Convex provider (env absent) the hooks below have no client to talk to.
  if (!convexConfigured) {
    return (
      <section>
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("notConfigured")}</p>
      </section>
    );
  }
  return <SharingInner />;
}

function SharingInner() {
  const { t } = useTranslation("collab");
  const { isAuthenticated } = useConvexAuth();
  const [queryNow] = useState(() => Date.now());
  const user = useQuery(api.auth.getCurrentUser) as AuthUser;
  const social = useQuery(api.social.listSocial) as Social | undefined;
  const invites = useQuery(api.projects.listInvites, { now: queryNow }) as Invite[] | undefined;
  const inbox = useQuery(api.heads.inbox) as
    | Array<{ projectId: string; actors: number; mediaRequested: boolean; keyRequested: boolean; updatedAt: number }>
    | undefined;
  const devices = useQuery(api.devices.listDevices) as
    | Array<{ deviceId: string; label?: string; createdAt: number; lastSeenAt: number }>
    | undefined;
  const projects = useQuery(api.projects.listProjectSummaries) as ProjectSummary[] | undefined;

  const upsertProfile = useMutation(api.social.upsertProfile);
  const sendRequest = useMutation(api.social.sendRequest);
  const respondRequest = useMutation(api.social.respondRequest);
  const removeFriend = useMutation(api.social.removeFriend);
  const clearInbox = useMutation(api.heads.clearInbox);

  const [nativeReady, setNativeReady] = useState<boolean | null>(null);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null);
  const [identifier, setIdentifier] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The local document behind each project: its name is the only human-readable identity a shared
  // project has on this machine, and it is what a delete or a leave must clean up with it.
  const [bindings, setBindings] = useState<Map<string, CollabBinding>>(new Map());
  const [confirmProject, setConfirmProject] = useState<string | null>(null);
  const [showAbsent, setShowAbsent] = useState(false);

  const reloadBindings = useCallback(() => {
    void collabBindings().then(setBindings);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void refreshNativeCollaborationAuth()
      .then(async (ready) => {
        if (cancelled) return;
        setNativeReady(ready);
        setNativeError(ready ? null : t("device.unavailable"));
        if (ready) setCurrentDeviceId((await deviceIdentity()).deviceId);
      })
      .catch((error) => {
        if (cancelled) return;
        setNativeReady(false);
        setNativeError(collabErrorMessage(error, t("device.unavailable")));
      });
    return () => { cancelled = true; };
  }, [isAuthenticated, t]);

  useEffect(() => reloadBindings(), [reloadBindings]);

  useEffect(() => {
    if (!isAuthenticated || !user?.name) return;
    void upsertProfile({ handle: user.name }).catch(() => undefined);
  }, [isAuthenticated, user?.name, user?.image, upsertProfile]);

  if (!isAuthenticated) {
    return (
      <section>
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t("signedOut")}</p>
      </section>
    );
  }

  async function add() {
    const wanted = identifier.trim();
    if (!wanted || busy) return;
    setBusy(true);
    try {
      const result = (await sendRequest({ identifier: wanted })) as { status: string };
      setStatus(result.status);
      if (["sent", "linked", "invited"].includes(result.status)) setIdentifier("");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function answerInvite(invite: Invite, accept: boolean) {
    if (!(await refreshNativeCollaborationAuth())) throw new Error(t("device.unavailable"));
    const result = await respondInviteNative(invite.inviteId, accept);
    if (!accept || result.status !== "joined" || !result.projectId) return;
    // A project already bound keeps its document: accepting a re-invitation (after a leave, or a
    // stale invite from an old build) must not mint a second identical one.
    if (bindings.has(result.projectId)) return;
    const surface = collabSurface(invite.surface);
    // A surface this build does not know cannot be adopted. The project stays in the list below
    // with no local document, which is what it is — better than a document nothing can open.
    if (!surface) return;
    const name = invite.from.name || invite.from.handle || t("invites.shared");
    const binding = await surface.adopt(result.projectId, name);
    setBindings((current) => new Map(current).set(binding.projectId, binding));
  }

  async function revokeDevice(deviceId: string) {
    if (busy || deviceId === currentDeviceId) return;
    setBusy(true);
    setNativeError(null);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("device.unavailable"));
      await forgetDevice(deviceId);
    } catch (error) {
      setNativeError(collabErrorMessage(error, t("device.unavailable")));
    } finally {
      setBusy(false);
    }
  }

  async function adoptProject(project: ProjectSummary) {
    const surface = collabSurface(project.surface);
    if (busy || !surface || bindings.has(project.projectId)) return;
    setBusy(true);
    try {
      const name = t("projects.unnamed", {
        date: new Date(project.createdAt).toLocaleDateString(uiLocale()),
      });
      const binding = await surface.adopt(project.projectId, name);
      setBindings((current) => new Map(current).set(binding.projectId, binding));
    } catch (error) {
      setNativeError(collabErrorMessage(error, t("projects.failed")));
    } finally {
      setBusy(false);
    }
  }

  // Delete (owner) or leave (member) straight from the account list: a project an old build left
  // behind has no local document, so a dialog on the document itself could never reach it.
  async function removeProject(project: ProjectSummary) {
    if (busy) return;
    const own = project.role === "owner";
    setBusy(true);
    setNativeError(null);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("device.unavailable"));
      if (own) await deleteProjectNative(project.projectId);
      else await leaveProjectNative(project.projectId);
      const binding = bindings.get(project.projectId);
      const surface = collabSurface(project.surface);
      if (binding && surface) await surface.forget(binding);
      setBindings((current) => {
        const next = new Map(current);
        next.delete(project.projectId);
        return next;
      });
      // A view may still be projecting the very document that just went away; it has to leave it
      // rather than keep painting a dead projection.
      surface?.onRemoved?.(project.projectId);
      setConfirmProject(null);
    } catch (error) {
      setNativeError(collabErrorMessage(error, t("projects.failed")));
    } finally {
      setBusy(false);
    }
  }

  // One row per shared project, bound or not. Everything optional stays silent: the role only when
  // it is not "owner" (the overwhelming default), the rotation only when pending, the adopt button
  // only when the document is absent from this machine and its module is loaded.
  function projectRow(project: ProjectSummary, name: string, addable: boolean) {
    const own = project.role === "owner";
    const confirming = confirmProject === project.projectId;
    const surface = collabSurface(project.surface);
    const detail = [
      surface ? t(surface.labelKey) : project.surface,
      own ? null : t(`projects.role.${project.role}`),
      project.rotationRequired ? t("projects.rotation") : null,
    ].filter(Boolean).join(" · ");
    return (
      <div key={project.projectId} className="flex items-center gap-3 py-2">
        <Users className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs">{name}</p>
          {detail && <p className="truncate text-[10px] text-muted-foreground">{detail}</p>}
        </div>
        {confirming ? (
          <>
            <span className="text-xs text-muted-foreground">
              {t(own ? "projects.confirmDelete" : "projects.confirmLeave")}
            </span>
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void removeProject(project)}
            >
              {t(own ? "projects.delete" : "projects.leave")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmProject(null)}>
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <>
            {addable && surface && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void adoptProject(project)}>
                {t("projects.add")}
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              aria-label={t(own ? "projects.delete" : "projects.leave")}
              onClick={() => setConfirmProject(project.projectId)}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
    );
  }

  const absent = (projects ?? []).filter((project) => !bindings.has(project.projectId));
  const present = (projects ?? []).filter((project) => bindings.has(project.projectId));

  return (
    <>
      <SectionTitle title={t("title")} info={t("subtitle")} />

      <section className="mt-6">
        <SectionTitle title={t("device.title")} info={t("device.subtitle")} />
        <div className="mt-3 flex items-center gap-3 rounded-lg border border-border p-3">
          <Laptop className="size-4 shrink-0 text-muted-foreground" />
          {!collabAvailable() ? (
            <p className="text-xs text-muted-foreground">{t("device.desktopOnly")}</p>
          ) : nativeError ? (
            <p className="text-xs text-destructive">{nativeError}</p>
          ) : nativeReady ? (
            <p className="text-xs text-muted-foreground">{t("device.ready")}</p>
          ) : (
            <Spinner className="size-4" />
          )}
        </div>
        {!!devices?.length && (
          <div className="mt-2 divide-y divide-border rounded-lg border border-border px-3">
            {devices.map((device) => (
              <div key={device.deviceId} className="flex items-center gap-3 py-2">
                <Laptop className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs">
                    {device.label || t("device.unnamed")}
                    {device.deviceId === currentDeviceId ? ` · ${t("device.current")}` : ""}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {device.deviceId.slice(0, 12)}…
                  </p>
                </div>
                {device.deviceId !== currentDeviceId && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("device.revoke")}
                    onClick={() => void revokeDevice(device.deviceId)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6">
        <SectionTitle title={t("friends.title")} info={t("friends.subtitle")} />
        {/* The Discord username, not the internal handle. The stored handle carries a suffix
            derived from the account id so two people with the same name cannot collide or
            pre-claim each other's — useful as a key, meaningless to read, and nobody would ever
            type it: a Discord username is already unique and is what people actually exchange. */}
        {(social?.self?.discordUsername || social?.self?.handle) && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("friends.yourHandle", {
              handle: social.self.discordUsername || social.self.handle,
            })}
          </p>
        )}
        <div className="mt-3 flex gap-2">
          <Input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void add(); }}
            placeholder={t("friends.placeholder")}
            className="h-8"
          />
          <Button size="sm" disabled={busy || !identifier.trim()} onClick={() => void add()}>
            <UserPlus className="size-3.5" /> {t("friends.add")}
          </Button>
        </div>
        {status && <p className="mt-2 text-xs text-muted-foreground">{t(`friends.status.${status}`)}</p>}
        {social === undefined ? <Spinner className="mt-3 size-4" /> : (
          <div className="mt-3 divide-y divide-border rounded-lg border border-border px-3">
            {social.incoming.map((request) => (
              <Row key={request.requestId} profile={request}>
                <Button size="sm" variant="ghost" onClick={() => void respondRequest({ requestId: request.requestId, accept: true })}>
                  <Check className="size-3.5" /> {t("friends.accept")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void respondRequest({ requestId: request.requestId, accept: false })}>
                  <X className="size-3.5" />
                </Button>
              </Row>
            ))}
            {social.outgoing.map((request) => (
              <Row key={request.requestId} profile={request}>
                {/* Two very different waits: an answer from someone who is here, or a first sign-in
                    from someone who is not. One label for both left the sender wondering whether
                    the invitation had even arrived. */}
                <span className="text-xs text-muted-foreground">
                  {request.pending ? t("friends.notYetJoined") : t("friends.awaiting")}
                </span>
                <Button size="sm" variant="ghost" onClick={() => void respondRequest({ requestId: request.requestId, accept: false })}>
                  <X className="size-3.5" />
                </Button>
              </Row>
            ))}
            {social.friends.map((friend) => (
              <Row key={friend.userId} profile={friend}>
                <Button size="sm" variant="ghost" onClick={() => void removeFriend({ friendId: friend.userId })}>
                  {t("friends.remove")}
                </Button>
              </Row>
            ))}
            {!social.friends.length && !social.incoming.length && !social.outgoing.length && (
              <p className="py-3 text-xs text-muted-foreground">{t("friends.empty")}</p>
            )}
          </div>
        )}
      </section>

      {!!invites?.length && (
        <section className="mt-6">
          <h2 className="text-sm font-medium">{t("invites.title")}</h2>
          <div className="mt-3 divide-y divide-border rounded-lg border border-border px-3">
            {invites.map((invite) => (
              <Row key={invite.inviteId} profile={invite.from}>
                <span className="text-xs text-muted-foreground">
                  {t(collabSurface(invite.surface)?.labelKey ?? "surface.unknown")}
                </span>
                <Button size="sm" onClick={() => void answerInvite(invite, true)}>
                  <Check className="size-3.5" /> {t("invites.join")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void answerInvite(invite, false)}>
                  <X className="size-3.5" />
                </Button>
              </Row>
            ))}
          </div>
        </section>
      )}

      {!!projects?.length && (
        <section className="mt-6">
          <SectionTitle title={t("projects.title")} info={t("projects.subtitle")} />

          {/* Documents on this machine: the name is enough — they open from their own module, and
              the only gesture left here is to part with them. */}
          {!!present.length && (
            <div className="mt-3 divide-y divide-border rounded-lg border border-border px-3">
              {present.map((project) =>
                projectRow(project, bindings.get(project.projectId)!.name, false))}
            </div>
          )}

          {/* The rest — shares from older builds, documents living on another machine — is folded
              away: a column of identical lines nobody knows anything about is noise. The folded
              line says the count; expanding gives each its adopt button and its bin. */}
          {!!absent.length && (
            <div className="mt-2 overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setShowAbsent((current) => !current)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                {showAbsent ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                {t("projects.absent", { count: absent.length })}
              </button>
              {showAbsent && (
                <div className="divide-y divide-border border-t border-border px-3">
                  {absent.map((project) => projectRow(
                    project,
                    t("projects.unnamed", {
                      date: new Date(project.createdAt).toLocaleDateString(uiLocale()),
                    }),
                    true,
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {!!inbox?.length && (
        <section className="mt-6">
          <h2 className="text-sm font-medium">{t("activity.title")}</h2>
          <div className="mt-3 divide-y divide-border rounded-lg border border-border px-3">
            {inbox.map((notice) => (
              <div key={notice.projectId} className="flex items-center gap-3 py-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {notice.keyRequested
                    ? t("activity.key", { count: notice.actors })
                    : notice.mediaRequested
                      ? t("activity.media", { count: notice.actors })
                      : t("activity.changed", { count: notice.actors })}
                </p>
                <Button size="sm" variant="ghost" onClick={() => void clearInbox({ projectId: notice.projectId })}>
                  {t("activity.dismiss")}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
