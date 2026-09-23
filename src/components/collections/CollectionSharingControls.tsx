// Carte « Partage » de l'éditeur de collection — MÊME forme que Médias et Archiver sur disque :
// icône + libellé + interrupteur Activé/Désactivé + chevron, et tout le reste dans le volet déplié.
//
// Allumer l'interrupteur PUBLIE la collection, et partager une collection c'est l'archiver : la carte
// « Archiver sur disque » s'allume donc d'elle-même et se verrouille (`core/collectionSharing.js`).
// Aucun réglage d'encodage ici : le format se choisit dans la carte d'archivage, une seule fois.
//
// Les droits de chaque personne tiennent en UN menu, parce qu'ils sont un seul choix :
//   Lecture seule                 → reçoit les plans, n'ajoute rien, ne retire rien.
//   Modification — ses plans      → ajoute, retire et modifie CE QU'ELLE a ajouté (défaut).
//   Modification — tous les plans → idem sur les contributions de tout le monde.
// Le rôle vit sur Convex (`projectMembers.role`) et la délégation à côté (`canDeleteOthers`) ; le
// menu écrit les deux, pour qu'il n'y ait jamais deux endroits où régler la même chose.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { ChevronRight, CircleHelp, UserRound, Users } from "lucide-react";
import { api } from "@/lib/convexApi";
import { convexConfigured } from "@/lib/convexEnv";
import { shareCollection, unbindCollection } from "@/lib/collab/collection/session";
import { deleteProject, leaveProject, setMemberRole } from "@/lib/collab/client";
import { collabErrorText } from "@/lib/collab/errors";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { CollaborationDialog } from "@/components/collab/CollaborationDialog";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Props = {
  projectId: string | null;
  /** Collection déjà enregistrée sur ce disque — absente tant qu'on n'a jamais enregistré. */
  collectionId: string | null;
  /** Rien à publier encore (pas de nom), ou un enregistrement est déjà en cours. */
  disabled: boolean;
  open: boolean;
  onToggleOpen: () => void;
  saveLocal: () => Promise<string>;
  onPublished: (projectId: string) => void;
  onBusyChange: (busy: boolean) => void;
  /** Le partage s'arrête et la collection RESTE ici : seul le lien au projet disparaît. */
  onUnshared: () => void;
  /** La collection elle-même s'en va (partage reçu qu'on quitte) : l'éditeur doit fermer. */
  onRemoved: () => void;
};

type Member = { userId: string; name: string; handle: string; image: string | null; role: string; canDeleteOthers?: boolean };
type Project = { role: string; members: Member[]; pending: Array<Member & { inviteId: string }> };

/** Les trois droits possibles, tels que la personne les lit. */
type Permission = "view" | "own" | "all";
const permissionOf = (member: { role: string; canDeleteOthers?: boolean }): Permission =>
  member.role !== "editor" ? "view" : member.canDeleteOthers ? "all" : "own";
const permissionKey = (permission: Permission) =>
  permission === "view" ? "share.permView" : permission === "all" ? "share.permAll" : "share.permOwn";

function Avatar({ url }: { url: string | null }) {
  return url
    ? <img src={url} alt="" referrerPolicy="no-referrer" className="size-6 shrink-0 rounded-full object-cover" />
    : <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><UserRound className="size-3.5" /></span>;
}

/** En-tête de carte, calqué sur celui de l'archivage (mêmes espacements, même chevron). */
function Card({ open, onToggleOpen, control, children }: {
  open: boolean; onToggleOpen: () => void; control: React.ReactNode; children?: React.ReactNode;
}) {
  const { t } = useTranslation("collections");
  const hint = t("share.viaArchive");
  return <div className="overflow-hidden rounded-lg border border-border bg-card">
    <div className="flex items-center pr-3">
      <button type="button" aria-expanded={open} onClick={onToggleOpen}
        className="flex flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50">
        <span className="text-muted-foreground"><Users className="size-4" /></span>
        <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
          {t("share.title")}
          {/* Le « pourquoi » tient dans une bulle : la phrase en clair mangeait un quart de la fenêtre. */}
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} aria-label={hint} className="inline-flex shrink-0 text-muted-foreground"
              onClick={(event) => event.stopPropagation()} />}>
              <CircleHelp className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{hint}</TooltipContent>
          </Tooltip>
        </span>
      </button>
      {control}
      <button type="button" aria-label={t("share.title")} aria-expanded={open} onClick={onToggleOpen}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
      </button>
    </div>
    {open && children && <div className="space-y-2.5 border-t border-border px-3 py-3">{children}</div>}
  </div>;
}

export function CollectionSharingControls(props: Props) {
  const { t } = useTranslation("collections");
  if (!convexConfigured) {
    return <Card open={false} onToggleOpen={() => {}}
      control={<span className="mr-2.5 shrink-0 text-[11px] text-muted-foreground">{t("share.unavailable")}</span>} />;
  }
  return <SharingInner {...props} />;
}

function SharingInner({ projectId, collectionId, disabled, open, onToggleOpen, saveLocal, onPublished, onBusyChange, onUnshared, onRemoved }: Props) {
  const { t } = useTranslation(["collections", "common"]);
  const { isAuthenticated } = useConvexAuth();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Une seule lecture de l'horloge : la requête est mémorisée sur ses arguments, une date qui change
  // à chaque rendu la relancerait en boucle.
  const [now] = useState(() => Date.now());
  const project = useQuery(api.projects.getProjectDetails,
    projectId && isAuthenticated ? { projectId, now } : "skip") as Project | null | undefined;
  const owner = project?.role === "owner";

  async function publish() {
    setBusy(true); setError(null); onBusyChange(true);
    try {
      const id = await saveLocal();
      const result = await shareCollection(id);
      onPublished(result.projectId);
      if (!open) onToggleOpen();
    } catch (cause) { setError(collabErrorText(cause, t("share.failed"))); }
    finally { setBusy(false); onBusyChange(false); }
  }

  async function stop() {
    if (!projectId) return;
    setBusy(true); setError(null); onBusyChange(true);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("share.signIn"));
      // Propriétaire : le projet partagé disparaît, la collection reste ici. Invité : on quitte, et
      // la collection reçue s'en va avec le partage — il n'y avait rien à garder en local.
      if (owner) {
        await deleteProject(projectId);
        if (collectionId) await unbindCollection(collectionId);
        setStopping(false); onUnshared();
      }
      else { await leaveProject(projectId); onRemoved(); }
    } catch (cause) { setError(collabErrorText(cause, t("share.failed"))); }
    finally { setBusy(false); onBusyChange(false); }
  }

  const shared = !!projectId;
  const control = <Toggle size="sm" variant="outline" pressed={shared}
    disabled={busy || (!shared && (disabled || !isAuthenticated))}
    onPressedChange={(next) => { if (next) void publish(); else { setStopping(true); if (!open) onToggleOpen(); } }}
    className="mr-2.5 shrink-0 text-xs text-muted-foreground aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary">
    {busy ? <Spinner className="size-3.5" /> : shared ? t("editor.on") : t("editor.off")}
  </Toggle>;

  return <Card open={open} onToggleOpen={onToggleOpen} control={control}>
    {!isAuthenticated && <p className="text-xs text-muted-foreground">{t("share.signIn")}</p>}
    {stopping && <div className="space-y-2 rounded-md border border-destructive/40 p-2">
      <p className="text-xs text-muted-foreground">{t("share.stopHint")}</p>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setStopping(false)}>{t("common:action.cancel")}</Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={() => void stop()}>
          {t(owner ? "share.stop" : "share.leave")}
        </Button>
      </div>
    </div>}
    {shared && !stopping && <>
      <div className="space-y-1.5">
        {project?.members.map((member) => <div key={member.userId} className="flex items-center gap-2">
          <Avatar url={member.image} />
          <span className="min-w-0 flex-1 truncate text-xs">{member.name || member.handle}</span>
          {member.role === "owner"
            ? <span className="shrink-0 text-[11px] text-muted-foreground">{t("share.owner")}</span>
            : owner
              ? <PermissionSelect projectId={projectId!} member={member} onError={setError} />
              : <span className="shrink-0 text-[11px] text-muted-foreground">{t(permissionKey(permissionOf(member)))}</span>}
        </div>)}
        {project?.pending.map((member) => <div key={member.inviteId} className="flex items-center gap-2 opacity-60">
          <Avatar url={member.image} />
          <span className="min-w-0 flex-1 truncate text-xs">{member.name || member.handle}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{t("share.pending")}</span>
        </div>)}
        {project && !project.members.some((member) => member.role !== "owner") && !project.pending.length
          && <p className="text-xs text-muted-foreground">{t("share.nobody")}</p>}
      </div>
      {owner && <Button size="sm" variant="outline" className="w-full" onClick={() => setPicking(true)}>
        {t("share.people")}
      </Button>}
    </>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <CollaborationDialog open={picking} onOpenChange={setPicking} projectId={projectId} memberRoles={false}
      onRemoved={onRemoved} onShare={async () => {
        const id = await saveLocal();
        const result = await shareCollection(id);
        onPublished(result.projectId);
        return result;
      }} />
  </Card>;
}

/**
 * Le droit d'une personne, en un seul menu. Passer en Modification AVANT de déléguer : le serveur
 * refuse une délégation posée sur un lecteur, justement pour qu'elle ne survive pas au rôle.
 */
function PermissionSelect({ projectId, member, onError }: {
  projectId: string; member: Member; onError: (message: string | null) => void;
}) {
  const { t } = useTranslation("collections");
  const setPermission = useMutation(api.collectionAccess.setPermission);
  const [busy, setBusy] = useState(false);
  const current = permissionOf(member);
  return <Select value={current} disabled={busy} onValueChange={async (value) => {
    const next = value as Permission;
    if (next === current) return;
    setBusy(true); onError(null);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("share.signIn"));
      if (next === "view") await setMemberRole(projectId, member.userId, "viewer");
      else {
        if (member.role !== "editor") await setMemberRole(projectId, member.userId, "editor");
        await setPermission({ projectId, userId: member.userId, allowed: next === "all" });
      }
    } catch (cause) { onError(collabErrorText(cause, t("share.failed"))); }
    finally { setBusy(false); }
  }}>
    <SelectTrigger size="sm" className="w-44 shrink-0">
      <SelectValue>{t(permissionKey(current))}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="view">{t("share.permView")}</SelectItem>
      <SelectItem value="own">{t("share.permOwn")}</SelectItem>
      <SelectItem value="all">{t("share.permAll")}</SelectItem>
    </SelectContent>
  </Select>;
}
