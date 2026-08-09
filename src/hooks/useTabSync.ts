import { useEffect } from "react";
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";

// À chaque changement d'onglet : déclenche UN poll LÉGER de la signature Resolve (refreshNow →
// `bridge.sig()`). Le core diff vs la dernière signature connue et ne broadcast `resolve:changed`
// QUE sur différence → useResolveSync refetch alors CIBLÉ (statut / Media Pool / timelines).
// Donc la nav ne fait qu'une VÉRIFICATION : aucune donnée n'est rechargée si rien n'a changé.
export function useTabSync() {
  const tab = useApp((s) => s.tab);
  useEffect(() => { nr.refreshNow(); }, [tab]);
}
