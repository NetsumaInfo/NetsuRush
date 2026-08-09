// Worker du correcteur : charge les dictionnaires Hunspell (nspell) et répond aux vérifications et
// aux suggestions. HORS du thread principal parce que la construction d'un dictionnaire français
// (84 000 racines + affixes) prend plusieurs centaines de ms et que `suggest` explore un voisinage
// d'édition — dans le thread UI, chaque suggestion ferait sauter la frappe.
import NSpell from "nspell";
import type { SpellLang, SpellRequest, SpellResponse } from "./spellShared";

// Le programme TypeScript du renderer est typé DOM ; on décrit donc la portée du worker à la main
// plutôt que de tirer `lib: webworker` (qui entrerait en collision avec les globales DOM).
interface WorkerScope {
  onmessage: ((event: MessageEvent<SpellRequest>) => void) | null;
  postMessage: (message: SpellResponse) => void;
}
const scope = self as unknown as WorkerScope;

type Checker = ReturnType<typeof NSpell>;

const checkers = new Map<SpellLang, Checker>();
const decoder = new TextDecoder("utf-8");

function load(lang: SpellLang, aff: ArrayBuffer, dic: ArrayBuffer, personal: readonly string[]) {
  const checker = NSpell(decoder.decode(aff), decoder.decode(dic));
  for (const word of personal) checker.add(word);
  checkers.set(lang, checker);
  scope.postMessage({ type: "loaded", lang });
}

scope.onmessage = (event: MessageEvent<SpellRequest>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "load":
        if (checkers.has(msg.lang)) scope.postMessage({ type: "loaded", lang: msg.lang });
        else load(msg.lang, msg.aff, msg.dic, msg.personal);
        return;
      case "check": {
        const checker = checkers.get(msg.lang);
        // Dictionnaire pas encore prêt → aucun mot fautif : on ne souligne jamais à l'aveugle.
        scope.postMessage({ type: "check", id: msg.id, bad: checker ? msg.words.filter((w) => !checker.correct(w)) : [] });
        return;
      }
      case "suggest": {
        const checker = checkers.get(msg.lang);
        scope.postMessage({ type: "suggest", id: msg.id, suggestions: checker ? checker.suggest(msg.word) : [] });
        return;
      }
      case "personal": {
        const checker = checkers.get(msg.lang);
        for (const word of msg.words) checker?.add(word);
        return;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (msg.type === "load") scope.postMessage({ type: "failed", lang: msg.lang, error });
    else if (msg.type === "check") scope.postMessage({ type: "check", id: msg.id, bad: [] });
    else if (msg.type === "suggest") scope.postMessage({ type: "suggest", id: msg.id, suggestions: [] });
  }
};
