import { useCollabBridge } from "./useCollabBridge";

/** Native collaboration owns membership, peers, keys and persistence; this component only keeps
 * the currently loaded scene projected into the board renderer. */
export function CollabHost() {
  useCollabBridge();
  return null;
}
