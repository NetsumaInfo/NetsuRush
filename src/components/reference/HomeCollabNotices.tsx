// Invitations et activité collaborative SUR L'ACCUEIL : accepter un partage ne doit pas demander
// d'aller fouiller Paramètres › Compte. Chaque invitation est une petite carte — rejoindre, refuser,
// ou plus tard (masquée jusqu'au prochain lancement, elle reste disponible dans les Paramètres).
// Rejoindre crée la scène liée (jamais deux pour le même projet) et ouvre le board directement.
//
// Ce fichier n'est monté que si Convex est configuré ET derrière un import lazy : la chaîne
// convex/react ne doit pas entrer dans le bundle de démarrage (cf. src/lib/convexEnv.ts).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConvexAuth, useQuery } from "convex/react";
import { Check, Clock, UserRound, X } from "lucide-react";
import { api } from "@/lib/convexApi";
import { nr } from "@/lib/bridge";
import { refreshNativeCollaborationAuth } from "@/lib/collab/authBridge";
import { collabErrorMessage, respondInvite } from "@/lib/collab/client";
import { collabSurface } from "@/lib/collab/surfaces";
import { BOARD_SURFACE } from "./collabSurface";
import { useBoard } from "./useReferenceBoard";
import { Button } from "@/components/ui/button";

type Profile = { userId: string; handle: string; name: string; image: string | null };
type Invite = {
  inviteId: string;
  projectId: string;
  role: string;
  /** Module invité. Une invitation pour un carnet n'a rien à faire sur l'accueil du board. */
  surface: string;
  from: Profile;
};
type InboxNotice = {
  projectId: string;
  actors: number;
  mediaRequested: boolean;
  keyRequested: boolean;
  updatedAt: number;
};

// « Plus tard » vaut pour la session : au prochain lancement l'invitation revient, et elle reste
// visible dans Paramètres › Compte entre-temps.
const snoozed = new Set<string>();

/** Ce qu'un board partagé attend, en un mot, pour la pastille de sa carte d'accueil. */
export type CollabCardStatus = "key" | "media" | "changed";

export function HomeCollabNotices({ onOpenScene, onCardStatus }: {
  onOpenScene: (sceneId: string) => void;
  /** Remonte l'état par SCÈNE : c'est la carte du board qui le porte, pas une carte flottante. */
  onCardStatus: (byScene: Record<string, CollabCardStatus>) => void;
}) {
  const { t } = useTranslation(["reference", "collab"]);
  const { isAuthenticated } = useConvexAuth();
  const [now] = useState(() => Date.now());
  const invites = useQuery(api.projects.listInvites, isAuthenticated ? { now } : "skip") as
    | Invite[]
    | undefined;
  const inbox = useQuery(api.heads.inbox, isAuthenticated ? {} : "skip") as
    | InboxNotice[]
    | undefined;

  const [busy, setBusy] = useState<string | null>(null);
  const [, forceRender] = useState(0);
  const [linkedScenes, setLinkedScenes] = useState<Map<string, { sceneId: string; name: string }>>(
    new Map(),
  );

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    void nr.reference?.listScenes().then((scenes) => {
      if (cancelled) return;
      const linked = new Map<string, { sceneId: string; name: string }>();
      for (const scene of scenes) {
        if (scene.collaboration?.projectId) {
          linked.set(scene.collaboration.projectId, { sceneId: scene.id, name: scene.name });
        }
      }
      setLinkedScenes(linked);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  // L'activité ne s'affiche plus en carte flottante : elle devient la pastille de la carte du board
  // concerné. Un avis qui ne correspond à aucune scène locale n'a nulle part où se poser — il reste
  // dans Paramètres › Compte, qui garde la copie durable.
  useEffect(() => {
    const byScene: Record<string, CollabCardStatus> = {};
    for (const notice of inbox ?? []) {
      const linked = linkedScenes.get(notice.projectId);
      if (!linked) continue;
      byScene[linked.sceneId] = notice.keyRequested
        ? "key"
        : notice.mediaRequested
          ? "media"
          : "changed";
    }
    onCardStatus(byScene);
  }, [inbox, linkedScenes, onCardStatus]);

  const fail = (error: unknown) => {
    useBoard.getState().setNotice({
      kind: "error",
      text: collabErrorMessage(error, t("home.invites.failed")),
    });
  };

  async function join(invite: Invite) {
    if (busy) return;
    setBusy(invite.inviteId);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("collab:signedOut"));
      const result = await respondInvite(invite.inviteId, true);
      if (result.status !== "joined" || !result.projectId) {
        throw new Error(t("home.invites.failed"));
      }
      // Un projet déjà lié garde sa scène : rejoindre à nouveau (ré-invitation) ouvre l'existante
      // au lieu de fabriquer un deuxième board identique sur l'accueil.
      const existing = linkedScenes.get(result.projectId);
      if (existing) {
        onOpenScene(existing.sceneId);
        return;
      }
      // La scène est créée par la SURFACE, pas ici : c'est elle qui sait ce qu'est un board vide,
      // et c'est le même chemin que celui des Paramètres.
      const surface = collabSurface(BOARD_SURFACE);
      if (!surface) throw new Error(t("home.invites.failed"));
      const binding = await surface.adopt(
        result.projectId,
        invite.from.name || invite.from.handle || t("home.sharedBoard"),
      );
      onOpenScene(binding.subjectId);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  async function decline(invite: Invite) {
    if (busy) return;
    setBusy(invite.inviteId);
    try {
      if (!(await refreshNativeCollaborationAuth())) throw new Error(t("collab:signedOut"));
      await respondInvite(invite.inviteId, false);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  }

  function later(id: string) {
    snoozed.add(id);
    forceRender((n) => n + 1);
  }

  // Seules les invitations du BOARD s'affichent ici. Celle d'un autre module aurait créé une
  // scène vide pour un document que le board ne sait pas ouvrir ; elle reste dans les Paramètres.
  const visibleInvites = (invites ?? []).filter(
    (invite) => !snoozed.has(invite.inviteId) && (invite.surface ?? BOARD_SURFACE) === BOARD_SURFACE,
  );
  if (!isAuthenticated || !visibleInvites.length) return null;

  return (
    // fixed, pas absolute : l'accueil défile (overflow-y-auto), un absolute s'ancrerait au bas du
    // contenu déroulé et sortirait de l'écran dès que la grille Récent s'allonge.
    <div className="fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100%-2rem)] flex-col gap-2">
      {visibleInvites.map((invite) => (
        <div
          key={invite.inviteId}
          className="animate-in fade-in-0 slide-in-from-bottom-2 rounded-lg border border-border bg-popover p-3 shadow-lg shadow-black/30"
        >
          <div className="flex items-center gap-2.5">
            {invite.from.image ? (
              <img
                src={invite.from.image}
                alt=""
                className="size-8 rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-8 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <UserRound className="size-4" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {invite.from.name || invite.from.handle}
              </p>
              <p className="truncate text-xs text-muted-foreground">{t("home.invites.body")}</p>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === invite.inviteId}
              onClick={() => later(invite.inviteId)}
            >
              <Clock className="size-3.5" /> {t("home.invites.later")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === invite.inviteId}
              onClick={() => void decline(invite)}
            >
              <X className="size-3.5" /> {t("home.invites.decline")}
            </Button>
            <Button size="sm" disabled={busy === invite.inviteId} onClick={() => void join(invite)}>
              <Check className="size-3.5" /> {t("home.invites.join")}
            </Button>
          </div>
        </div>
      ))}

    </div>
  );
}
