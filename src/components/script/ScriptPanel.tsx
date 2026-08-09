// Entrée de l'onglet « Script ». Mode home (liste des documents) ou editor (document ouvert).
// Le projet Resolve courant scope la liste des scripts (multi-docs par projet) ; la portée choisie
// sur l'accueil (ce projet / tous) vit ici car elle survit à l'ouverture d'un document.

import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { usePersistedChoice } from "@/lib/persistedChoice";
import { useScript } from "./useScript";
import { useScriptPersistence } from "./useScriptPersistence";
import { ScriptHome } from "./ScriptHome";
import { ScriptEditor } from "./ScriptEditor";
import { HOME_SCOPES, type HomeScope } from "./home/homeShared";

export function ScriptPanel() {
  const project = useApp(useShallow((s) => s.status?.project ?? null));
  const hasDoc = useScript((s) => s.doc !== null);
  const [scope, setScope] = usePersistedChoice<HomeScope>("nr.script.home.scope", HOME_SCOPES, "project");
  const persistence = useScriptPersistence(project, scope);

  if (!hasDoc) return <ScriptHome project={project} scope={scope} onSetScope={setScope} persistence={persistence} />;
  return <ScriptEditor persistence={persistence} />;
}
