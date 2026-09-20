// Le serveur MCP officiel de Blackmagic, replié dans le registre d'outils.
//
// Ce qui est vérifié ici n'est pas le serveur (il appartient à Resolve) mais le
// CÂBLAGE : le préfixe, le risque attribué à chaque outil, et surtout le fait
// que l'outil hors bac à sable n'entre pas dans le registre tant que personne
// ne l'a demandé. Un serveur factice tient lieu de Resolve, sinon le test ne
// pourrait tourner que sur une machine avec Resolve Studio installé.

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { createToolRegistry } = require('../core/agent/tools/registry');
const { createResolveMcp, normalize, reprefix, RISK, MAX_CHARS } = require('../core/agent/tools/resolveMcp');
const { createMcpClient } = require('../core/agent/mcp/client');
const { findResolveMcp } = require('../core/agent/mcp/resolveBin');

// Les noms et les descriptions sont ceux du serveur livré avec Resolve 21.1.
const TOOLS = [
  { name: 'get_resolve_status', description: 'Check whether DaVinci Resolve is running.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search_scripting_api', description: 'Searches the scripting API stubs, so `get_scripting_api` is not needed.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } } },
  { name: 'run_script', description: 'Execute a sandboxed script. Use `get_scripting_api` first.', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
  { name: 'run_script_unsafe', description: 'Full system access.', inputSchema: { type: 'object', properties: { script: { type: 'string' } } } },
  { name: 'delete_lut', description: 'Delete a LUT file.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'a_tool_from_a_later_version', description: 'Unknown here.', inputSchema: { type: 'object', properties: {} } },
];

function fakeClient(calls = []) {
  return {
    start: async () => ({ serverInfo: { name: 'davinci_resolve', version: '21.1' }, instructions: '' }),
    listTools: async () => TOOLS,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ran ${name}` }] };
    },
    close: () => {},
    running: () => true,
  };
}

async function hydrated(extra = {}) {
  const registry = createToolRegistry();
  const calls = [];
  const mcp = createResolveMcp({ registry, bin: 'C:\\fake\\ResolveMCP.exe', client: fakeClient(calls), ...extra });
  await mcp.ready();
  return { registry, mcp, calls };
}

test('les outils du serveur arrivent préfixés, et le hors-bac-à-sable reste dehors', async () => {
  const { registry, mcp } = await hydrated();
  const names = registry.list().map((t) => t.name);

  assert.ok(names.includes('bmd_run_script'), 'run_script doit être exposé');
  assert.ok(names.every((n) => n.startsWith('bmd_')), 'tout doit porter le préfixe');
  assert.ok(!names.includes('bmd_run_script_unsafe'), 'l’outil hors bac à sable ne s’enregistre pas de lui-même');
  // 6 outils annoncés, 5 enregistrés : celui qui manque est bien l'unsafe.
  assert.equal(names.length, TOOLS.length - 1);

  const status = mcp.status();
  assert.equal(status.available, true);
  assert.equal(status.version, '21.1');
  assert.equal(status.unsafe, false);
});

test('le risque de chaque outil pilote la porte de permission, et l’inconnu est destructif', async () => {
  const { registry } = await hydrated();
  assert.equal(registry.get('bmd_get_resolve_status').risk, 'read');
  assert.equal(registry.get('bmd_search_scripting_api').risk, 'read');
  assert.equal(registry.get('bmd_delete_lut').risk, 'destructive');
  // Un script arbitraire contre le projet n'est pas une écriture ordinaire :
  // en mode « demander », une écriture passerait sans rien dire.
  assert.equal(registry.get('bmd_run_script').risk, 'destructive');
  // Un outil ajouté par une version future de Resolve ne doit pas atterrir en
  // lecture seule au motif que ce fichier ne le connaît pas.
  assert.equal(registry.get('bmd_a_tool_from_a_later_version').risk, 'destructive');
  assert.equal(RISK.run_script_unsafe, 'destructive');
});

test('l’interrupteur ajoute puis retire l’outil hors bac à sable, sans doublon', async () => {
  const { registry, mcp } = await hydrated();

  await mcp.setUnsafe(true);
  assert.ok(registry.get('bmd_run_script_unsafe'), 'activé, il doit être là');
  assert.equal(mcp.status().unsafe, true);

  // Re-hydrater remplace ce qui avait été enregistré : sans le retrait
  // préalable, le registre refuserait les doublons et la liste se figerait.
  await mcp.setUnsafe(false);
  assert.equal(registry.get('bmd_run_script_unsafe'), null);
  assert.equal(registry.list().length, TOOLS.length - 1);

  await mcp.setUnsafe(true);
  assert.equal(registry.list().length, TOOLS.length);
});

test('les outils ne sont proposés qu’à NetsuPilot, jamais à NetsuFlow', async () => {
  const { registry } = await hydrated();
  assert.ok(registry.toMcpTools('pilot').some((t) => t.name === 'bmd_run_script'));
  assert.equal(registry.toMcpTools('flow').filter((t) => t.name.startsWith('bmd_')).length, 0);
});

test('l’appel traverse le registre et revient normalisé', async () => {
  const { registry, calls } = await hydrated();
  const r = await registry.execute('bmd_run_script', { script: 'result = 1' }, {});
  assert.deepEqual(r, { ok: true, text: 'ran run_script' });
  // Le nom parti au serveur est le SIEN, pas le nôtre.
  assert.deepEqual(calls[0], { name: 'run_script', args: { script: 'result = 1' } });
});

test('une panne du serveur laisse le registre vide et le statut parlant', async () => {
  const registry = createToolRegistry();
  const mcp = createResolveMcp({
    registry,
    bin: 'C:\\fake\\ResolveMCP.exe',
    client: { start: async () => { throw new Error('Resolve fermé'); }, listTools: async () => [], close: () => {} },
  });
  await mcp.ready();
  assert.equal(registry.list().length, 0);
  const status = mcp.status();
  assert.equal(status.installed, true, 'le binaire est là…');
  assert.equal(status.available, false, '…mais il n’a pas répondu');
  assert.match(status.error, /Resolve fermé/);
});

test('les descriptions renvoient vers les noms préfixés', () => {
  const out = reprefix('Use `get_scripting_api` then `run_script`.', ['get_scripting_api', 'run_script']);
  assert.equal(out, 'Use `bmd_get_scripting_api` then `bmd_run_script`.');
});

test('les blocs de contenu MCP deviennent un résultat NetsuRush', () => {
  assert.deepEqual(
    normalize({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    { ok: true, text: 'a\nb' },
  );
  assert.deepEqual(
    normalize({ content: [{ type: 'text', text: 'boum' }], isError: true }),
    { ok: false, error: 'boum' },
  );
  assert.deepEqual(
    normalize({ content: [], structuredContent: { frames: 12 } }),
    { ok: true, data: { frames: 12 } },
  );
});

test('NR_RESOLVE_MCP l’emporte sur les emplacements d’installation', () => {
  const probe = path.join(os.tmpdir(), `nr-resolve-mcp-${process.pid}`);
  fs.writeFileSync(probe, '');
  const before = process.env.NR_RESOLVE_MCP;
  process.env.NR_RESOLVE_MCP = probe;
  try {
    assert.equal(findResolveMcp(), probe);
  } finally {
    if (before === undefined) delete process.env.NR_RESOLVE_MCP;
    else process.env.NR_RESOLVE_MCP = before;
    fs.unlinkSync(probe);
  }
});

test('le client stdio fait la poignée de main et l’appel d’outil', async () => {
  // Un serveur MCP minimal, en JSON par ligne : ce que le client doit savoir
  // parler pour tenir face à celui de Blackmagic.
  const server = [
    'let buf = "";',
    'process.stdin.on("data", (d) => {',
    '  buf += d.toString();',
    '  let i;',
    '  while ((i = buf.indexOf("\\n")) >= 0) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
    '    if (!line.trim()) continue;',
    '    const m = JSON.parse(line);',
    '    if (m.method === "initialize") out({ id: m.id, result: { serverInfo: { name: "fake", version: "1" } } });',
    '    if (m.method === "tools/list") out({ id: m.id, result: { tools: [{ name: "ping" }] } });',
    '    if (m.method === "tools/call") out({ id: m.id, result: { content: [{ type: "text", text: m.params.arguments.echo }] } });',
    '  }',
    '});',
    'function out(o) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n"); }',
  ].join('\n');

  const client = createMcpClient({ command: process.execPath, args: ['-e', server], label: 'fake' });
  try {
    const info = await client.start();
    assert.equal(info.serverInfo.name, 'fake');
    assert.deepEqual((await client.listTools()).map((t) => t.name), ['ping']);
    const r = await client.callTool('ping', { echo: 'pong' });
    assert.equal(r.content[0].text, 'pong');
  } finally {
    client.close();
  }
});

test('une seconde tentative rattrape un Resolve lancé après l’application', async () => {
  const registry = createToolRegistry();
  let up = false;
  const mcp = createResolveMcp({
    registry,
    bin: 'C:\fake\ResolveMCP.exe',
    client: {
      start: async () => {
        if (!up) throw new Error('Resolve fermé');
        return { serverInfo: { name: 'davinci_resolve', version: '21.1' }, instructions: '' };
      },
      listTools: async () => TOOLS,
      callTool: async () => ({ content: [] }),
      close: () => {},
    },
  });

  await mcp.ready();
  assert.equal(mcp.status().available, false);

  up = true; // l'utilisateur ouvre Resolve, puis relance la détection
  await mcp.refresh();
  assert.equal(mcp.status().available, true);
  assert.equal(registry.list().length, TOOLS.length - 1);

  // Une fois en place, retenter ne redemande rien au serveur et ne duplique rien.
  await mcp.refresh();
  assert.equal(registry.list().length, TOOLS.length - 1);
});

test('un résultat qui part en vrille est refusé, jamais tronqué', () => {
  const huge = 'x'.repeat(MAX_CHARS + 1);
  const r = normalize({ content: [{ type: 'text', text: huge }] }, 'run_script');
  assert.equal(r.ok, false);
  // Tronquer un stub d'API ferait lire au modèle l'absence d'une classe qui
  // existe : le refus doit donc être total, et dire quoi faire à la place.
  assert.ok(!('text' in r), 'aucun fragment ne doit passer');
  assert.match(r.error, /trop volumineux/);

  // Le stub complet de l'API, lui, passe : un outil qui échoue toujours serait
  // pire que cher (146 000 caractères mesurés sur Resolve 21.1).
  const stub = normalize({ content: [{ type: 'text', text: 'y'.repeat(146_000) }] }, 'get_scripting_api');
  assert.equal(stub.ok, true);
});

test('un script est jugé sur ce qu’il fait, pas sur son nom d’outil', async () => {
  const { registry } = await hydrated();
  const tool = registry.get('bmd_run_script');
  const risk = (input) => tool.riskFor(input);

  // Lire n'est pas écrire. Sans ce jugement, « qu'y a-t-il dans ma timeline ? »
  // ouvrait une confirmation, et le mode lecture seule refusait l'inspection.
  assert.equal(risk({ script: 'result = project.GetName()' }), 'read');
  assert.equal(risk({ script: 'tl = project.GetCurrentTimeline()\nresult = [i.GetName() for i in tl.GetItemListInTrack("video", 1)]' }), 'read');

  assert.equal(risk({ script: 'c.SetClipProperty("Clip Name", "x")' }), 'destructive');
  assert.equal(risk({ script: 'project.GetMediaPool().DeleteClips(clips)' }), 'destructive');
  assert.equal(risk({ script: 'tl.AddMarker(10, "Blue", "x", "", 1)' }), 'destructive');
  // Deux méthodes de l'API portent un verbe de la liste blanche des listes
  // Python : elles sont refusées nommément.
  assert.equal(risk({ script: 'mp.AppendToTimeline(clips)' }), 'destructive');
  // Une évaluation dynamique peut écrire sans qu'aucun appel ne le montre.
  assert.equal(risk({ script: 'exec("x = 1")' }), 'destructive');
  // Verbe inconnu = écriture : une méthode d'une version future de Resolve ne
  // doit pas passer en lecture au motif que ce fichier ne la connaît pas.
  assert.equal(risk({ script: 'project.FlorbTheTimeline()' }), 'destructive');
  assert.equal(risk({ script: '' }), 'destructive');

  // Le hors-bac-à-sable ne se juge PAS sur pièce : même en lecture, il atteint
  // le disque et le réseau.
  const { registry: r2, mcp } = await hydrated();
  await mcp.setUnsafe(true);
  const un = r2.get('bmd_run_script_unsafe');
  assert.equal(un.risk, 'destructive');
  assert.equal(un.riskFor, undefined);
});
