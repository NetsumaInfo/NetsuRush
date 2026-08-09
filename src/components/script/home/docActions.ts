// Renommer / dupliquer un document depuis l'accueil, sans l'ouvrir. Les deux passent par les
// canaux existants (loadDoc + saveDoc) : aucune IPC neuve.

import { nr } from "@/lib/bridge";
import type { ScriptDoc } from "@/lib/bridge";
import { uid } from "../scriptShared";

export interface DocActionResult { ok: boolean; error?: string }

async function loadOrFail(id: string): Promise<ScriptDoc | null> {
  return (await nr.script?.loadDoc(id)) ?? null;
}

export async function renameDoc(id: string, title: string): Promise<DocActionResult> {
  try {
    const doc = await loadOrFail(id);
    if (!doc) return { ok: false, error: "not-found" };
    const r = await nr.script?.saveDoc({ ...doc, title });
    return r?.ok ? { ok: true } : { ok: false, error: r?.error ?? "save-failed" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Les ids de blocs et de médias sont des CLÉS PRIMAIRES partagées par tous les documents : sauver
// une copie en gardant les ids d'origine ne crée pas de doublon, elle re-parente les blocs vers le
// nouveau document — le script copié se viderait. D'où la régénération complète des ids.
export async function duplicateDoc(id: string, title: string): Promise<DocActionResult & { id?: string }> {
  try {
    const doc = await loadOrFail(id);
    if (!doc) return { ok: false, error: "not-found" };
    const copy: ScriptDoc = {
      ...doc,
      id: uid(),
      title,
      blocks: doc.blocks.map((b) => ({
        ...b,
        id: uid(),
        media: b.media.map((m) => ({ ...m, id: uid() })),
      })),
    };
    const r = await nr.script?.saveDoc(copy);
    return r?.ok ? { ok: true, id: copy.id } : { ok: false, error: r?.error ?? "save-failed" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
