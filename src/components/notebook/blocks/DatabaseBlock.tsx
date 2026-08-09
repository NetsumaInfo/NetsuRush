// Bloc custom « Base de données » (/database) — héberge une grille dans le document de
// page. content:"none" : le bloc n'a pas de texte éditable BlockNote ; toute l'interaction vit dans la
// DatabaseView (React classique). La donnée est stockée SÉPARÉMENT (store.nbDatabases[dbId], persistée
// par la page via le core) — le bloc ne porte QUE l'id (props.dbId), le doc de page reste léger.
import { createReactBlockSpec } from "@blocknote/react";
import { DatabaseView } from "../db/DatabaseView";

export const databaseSpec = createReactBlockSpec(
  {
    type: "database",
    propSchema: {
      dbId: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => (
      // stopPropagation : les frappes dans les cellules ne doivent pas piloter le curseur BlockNote.
      <div
        contentEditable={false}
        className="my-2"
        onKeyDown={(e) => e.stopPropagation()}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <DatabaseView dbId={String(block.props.dbId)} />
      </div>
    ),
  },
)();
