// @ts-check
// Outil « board de référence » exposé à l'agent IA : lire/écrire les scènes du mood-board et y
// envoyer des médias (images / vidéos locales, ou un média distant résolu depuis une URL). Réutilise
// le MÊME store que les canaux reference:* (core/reference.js) et le MÊME canal de push que
// « Envoyer vers le board » (broadcast 'reference:push' {type:'path',path,title}) → le board vivant
// (onglet Référence ou fenêtre détachée) pose l'item. Dispatcher compound : 1 outil + param `action`.

/**
 * @param {{ refStore:any, broadcast:(ch:string,p:any)=>void }} deps
 * @returns {import('./registry').ToolDef[]}
 */
function createReferenceTools(deps) {
  const { refStore, broadcast } = deps;
  const ok = (/** @type {any} */ data) => ({ ok: true, ...(data && typeof data === 'object' ? data : { value: data }) });

  // Pousse un chemin disque vers le board vivant (même contrat que useReferencePush).
  const pushPath = (/** @type {string} */ p, /** @type {string} */ title) =>
    broadcast('reference:push', { type: 'path', path: p, title: title || p.replace(/^.*[\\/]/, '') });

  return [
    {
      name: 'board',
      description: 'Board de référence (mood-board). action: list_scenes | load_scene(id) | '
        + 'save_scene(scene) | delete_scene(id) | add_media(paths[],titles?) | add_url(url,title?). '
        + 'add_media envoie des fichiers image/vidéo locaux au board ouvert. add_url télécharge un '
        + 'média distant (page web, CDN, GIF) puis l’ajoute. add_media/add_url ne marchent que si le '
        + 'board est ouvert (onglet Référence ou fenêtre détachée).',
      risk: 'write',
      riskFor: (/** @type {any} */ a) => (a.action === 'list_scenes' || a.action === 'load_scene' ? 'read' : a.action === 'delete_scene' ? 'destructive' : 'write'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list_scenes', 'load_scene', 'save_scene', 'delete_scene', 'add_media', 'add_url'] },
          id: { type: 'string' },
          scene: { type: 'object', description: '{ id?, name, items[], view? }' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Chemins absolus image/vidéo' },
          titles: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['action'],
      },
      handler: async (/** @type {any} */ a) => {
        switch (a.action) {
          case 'list_scenes': return ok({ scenes: refStore.listScenes() });
          case 'load_scene': return ok({ scene: refStore.loadScene(String(a.id)) });
          case 'save_scene': return refStore.saveScene(a.scene || {});
          case 'delete_scene': return refStore.deleteScene(String(a.id));
          case 'add_media': {
            const paths = a.paths || [];
            paths.forEach((/** @type {string} */ p, /** @type {number} */ i) => pushPath(p, (a.titles || [])[i]));
            return ok({ added: paths.length });
          }
          case 'add_url': {
            const r = await refStore.resolveMedia(String(a.url || ''));
            if (!r || !r.ok || !r.path) return { ok: false, error: (r && r.error) || 'média introuvable' };
            pushPath(r.path, a.title);
            return ok({ added: 1, path: r.path, kind: r.kind });
          }
          default: throw new Error(`action board inconnue : ${a.action}`);
        }
      },
    },
  ];
}

module.exports = { createReferenceTools };
