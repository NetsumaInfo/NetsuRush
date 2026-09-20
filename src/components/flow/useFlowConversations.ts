// Plusieurs discussions dans le panneau NetsuFlow, plutôt qu'un fil unique
// qu'il fallait effacer pour repartir.
//
// Une composition se travaille par essais : « et si les ronds devenaient des
// carrés », « et si le fond respirait ». Chacun mérite son fil — mélangés, ils
// donnent au modèle un contexte qui contredit la demande en cours.
//
// Elles vivent SUR LE DISQUE, dans le même magasin que NetsuPilot mais sous sa
// propre surface (`NR_HOME/chat/flow`). Elles ont d'abord tenu dans le stockage
// local du navigateur, ce qui suffisait jusqu'au jour où vider le cache de la
// WebView les emporte — un historique de travail mérite mieux qu'un stockage
// qu'un nettoyage de cache efface. La bascule reprend ce qui s'y trouvait.
//
// Seuls le rôle et le texte sont conservés : la trace d'un tour (raisonnement,
// appels d'outils) décrit une exécution passée, la rejouer serait un faux.
import { useCallback, useEffect, useRef, useState } from "react";

import { nr, type ChatConvMeta } from "@/lib/bridge";
import type { UiMessage } from "@/store/chat";

const SURFACE = "flow";
/// La clé du stockage local d'avant. Lue une fois, puis effacée.
const LEGACY_KEY = "nr.flow.conversations";

const uid = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

/// Les messages persistés remontés dans la forme que le fil attend.
const restore = (messages: { role: "user" | "assistant"; content: string }[]): UiMessage[] =>
  messages.map((m) => ({
    id: uid(), role: m.role, content: m.content, thinking: "", tools: [], steps: [],
  }));

/// Le titre d'une discussion : le début de la première demande, faute de mieux.
/// Un numéro ne dit rien une semaine plus tard.
function titleOf(messages: UiMessage[], fallback: string) {
  const first = messages.find((m) => m.role === "user" && m.content.trim());
  if (!first) return fallback;
  return first.content.trim().replace(/\s+/g, " ").slice(0, 48);
}

/// Reprend ce que le stockage local contenait, une seule fois. Sans cela, la
/// bascule vers le disque jetterait en silence ce qui avait été écrit avant.
async function adoptLegacy(): Promise<number> {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return 0;
    stored = JSON.parse(raw);
  } catch { return 0; }
  if (!Array.isArray(stored)) return 0;

  let moved = 0;
  for (const c of stored) {
    const messages = Array.isArray(c?.messages) ? c.messages : [];
    if (!messages.length) continue;
    const saved = await nr.chat?.history.save({
      title: String(c?.title || "").slice(0, 48) || "Discussion",
      messages, surface: SURFACE,
    });
    if (saved?.ok) moved += 1;
  }
  // Effacée seulement après reprise : une erreur en route ne doit pas faire
  // disparaître la source.
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
  return moved;
}

/**
 * @param onLoad remplace le fil affiché — appelé quand on change de discussion.
 */
export function useFlowConversations(onLoad: (messages: UiMessage[]) => void) {
  const [list, setList] = useState<ChatConvMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // `onLoad` change à chaque rendu du parent ; le garder dans une ref évite de
  // relancer les effets qui s'en servent.
  const load = useRef(onLoad);
  useEffect(() => { load.current = onLoad; });

  const refresh = useCallback(async () => {
    const rows = await nr.chat?.history.list(SURFACE);
    if (rows) setList(rows);
    return rows ?? [];
  }, []);

  useEffect(() => {
    void (async () => {
      await adoptLegacy();
      await refresh();
    })();
  }, [refresh]);

  /// Écrit le fil courant dans la discussion active, ou en crée une. Appelé à
  /// chaque tour terminé : sans cela, fermer l'application perdrait le dernier
  /// échange.
  const remember = useCallback(async (messages: UiMessage[]) => {
    if (!messages.length) return;
    const saved = await nr.chat?.history.save({
      id: activeId ?? undefined,
      title: titleOf(messages, "Discussion"),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      surface: SURFACE,
    });
    if (saved?.ok && saved.id && saved.id !== activeId) setActiveId(saved.id);
    await refresh();
  }, [activeId, refresh]);

  const select = useCallback(async (id: string, current: UiMessage[]) => {
    if (id === activeId) return;
    await remember(current);
    const conversation = await nr.chat?.history.load(id, SURFACE);
    if (!conversation) return;
    setActiveId(id);
    load.current(restore(conversation.messages));
  }, [activeId, remember]);

  const create = useCallback(async (current: UiMessage[]) => {
    await remember(current);
    // Rien n'est écrit tant qu'il n'y a pas de message : une discussion vide
    // sur le disque serait une ligne qu'on ne peut ni lire ni supprimer avec
    // profit. Elle prend son identifiant au premier `remember`.
    setActiveId(null);
    load.current([]);
  }, [remember]);

  const remove = useCallback(async (id: string) => {
    await nr.chat?.history.delete(id, SURFACE);
    if (id === activeId) { setActiveId(null); load.current([]); }
    await refresh();
  }, [activeId, refresh]);

  return { list, activeId, select, create, remove, remember };
}
