// Pastille de présence du board : le composant partagé, alimenté par le store du board.

import { CollabStatus } from "@/components/collab/CollabStatus";
import { useBoard } from "./useReferenceBoard";

export function BoardCollabStatus() {
  const projectId = useBoard((state) => state.collabProjectId);
  const role = useBoard((state) => state.collabRole);
  const members = useBoard((state) => state.collabMembers);
  const offlineQueued = useBoard((state) => state.collabOfflineQueued);
  const rotationRequired = useBoard((state) => state.collabRotationRequired);

  return (
    <CollabStatus
      projectId={projectId}
      role={role}
      members={members}
      offlineQueued={offlineQueued}
      rotationRequired={rotationRequired}
    />
  );
}
