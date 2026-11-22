// External MCP access: the stdio server an outside client (Claude Desktop, Codex…) spawns, the
// shaping of tool results into MCP content, the client config writers, the job registry for long
// actions, and the permission gate's per-surface mode.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { negotiateVersion, toCallResult, PROTOCOL_VERSIONS } = require("../core/agent/mcp/format.js");
const { stripTomlServer, tomlServer } = require("../core/agent/mcp/external.js");
const { createJobs } = require("../core/agent/jobs.js");
const { buildDomainTool } = require("../core/agent/tools/app/domain.js");
const { createPermissions } = require("../core/agent/permissions.js");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `nr-mcp-${name}-`));

test("protocol negotiation echoes a known version and falls back to the newest", () => {
  assert.equal(negotiateVersion("2025-06-18"), "2025-06-18");
  assert.equal(negotiateVersion("1999-01-01"), PROTOCOL_VERSIONS[0]);
  assert.equal(negotiateVersion(undefined), PROTOCOL_VERSIONS[0]);
});

test("a plain result becomes text plus structured content", () => {
  const out = toCallResult({ ok: true, count: 2 });
  assert.equal(out.isError, false);
  assert.deepEqual(JSON.parse(out.content[0].text), { ok: true, count: 2 });
  assert.deepEqual(out.structuredContent, { ok: true, count: 2 });
});

test("a refused call is flagged as a tool error", () => {
  const out = toCallResult({ ok: false, error: "nope" });
  assert.equal(out.isError, true);
});

test("__images become image blocks and __files resource links, both stripped from the JSON", () => {
  const dir = tmp("img");
  const jpg = path.join(dir, "a.jpg");
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const video = path.join(dir, "clip.mp4");
  const out = toCallResult({ ok: true, path: jpg, __images: [jpg], __files: [{ path: video }] });
  const json = JSON.parse(out.content[0].text);
  assert.equal(json.__images, undefined);
  assert.equal(json.__files, undefined);
  const image = out.content.find((c) => c.type === "image");
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.data, Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"));
  const link = out.content.find((c) => c.type === "resource_link");
  assert.match(link.uri, /^file:\/\//);
  assert.equal(link.mimeType, "video/mp4");
  // Structured content is dropped when media rides along, so no client prefers it over the images.
  assert.equal(out.structuredContent, undefined);
});

test("an unreadable image is reported, not thrown", () => {
  const out = toCallResult({ ok: true, __images: [path.join(os.tmpdir(), "does-not-exist.png")] });
  assert.ok(out.content.some((c) => c.type === "text" && /omitted/.test(c.text)));
});

test("the codex TOML writer replaces only the netsurush table", () => {
  const before = [
    'model = "gpt-5"',
    "",
    "[mcp_servers.other]",
    'command = "x"',
    "",
    "[mcp_servers.netsurush]",
    "command = 'old'",
    "",
    "[mcp_servers.netsurush.env]",
    "A = 'b'",
    "",
    "[profiles.fast]",
    'model = "y"',
  ].join("\n");
  const stripped = stripTomlServer(before);
  assert.doesNotMatch(stripped, /netsurush/);
  assert.match(stripped, /\[mcp_servers\.other\]/);
  assert.match(stripped, /\[profiles\.fast\]/);
  const block = tomlServer({ command: "C:\\node\\node.exe", args: ["C:\\a\\stdio.js"], env: { NR_SURFACE: "external" } });
  // Literal strings: Windows backslashes need no escaping.
  assert.match(block, /command = 'C:\\node\\node\.exe'/);
  assert.match(block, /env = \{ NR_SURFACE = 'external' \}/);
});

test("installing into a JSON client keeps the rest of the file and backs it up", () => {
  const home = tmp("home");
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const { createExternalAccess } = require("../core/agent/mcp/external.js");
    const access = createExternalAccess({ dataDir: tmp("data") });
    const cfgPath = path.join(home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { keep: { command: "k" } }, other: 1 }));
    const res = access.install("cursor");
    assert.equal(res.ok, true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.other, 1);
    assert.equal(cfg.mcpServers.keep.command, "k");
    assert.equal(cfg.mcpServers.netsurush.env.NR_SURFACE, "external");
    assert.ok(fs.existsSync(`${cfgPath}.netsurush.bak`));
    assert.equal(access.clients().find((c) => c.id === "cursor").installed, true);
    assert.equal(access.uninstall("cursor").ok, true);
    assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf8")).mcpServers.netsurush, undefined);
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
  }
});

test("external settings persist and reject unknown modes", () => {
  const { createExternalAccess } = require("../core/agent/mcp/external.js");
  const dataDir = tmp("settings");
  const a = createExternalAccess({ dataDir });
  assert.deepEqual(a.get(), { enabled: true, mode: "ask", maxSubagents: 8 });
  a.set({ enabled: false, mode: "auto" });
  a.set({ mode: "bogus" });
  assert.deepEqual(createExternalAccess({ dataDir }).get(), { enabled: false, mode: "auto", maxSubagents: 8 });
});

test("a long job answers inline when quick and hands back a job id otherwise", async () => {
  const jobs = createJobs();
  const quick = await jobs.run("quick", async () => ({ ok: true, v: 1 }), { waitMs: 200 });
  assert.deepEqual(quick, { ok: true, v: 1 });
  let release;
  const slow = await jobs.run("slow", () => new Promise((r) => { release = r; }), { waitMs: 10 });
  assert.equal(slow.background, true);
  jobs.observe("search:progress", { done: 3, total: 10 });
  assert.equal(jobs.status(slow.jobId).progress.done, 3);
  release({ ok: true, out: "x" });
  const done = await jobs.wait(slow.jobId, 1);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { ok: true, out: "x" });
});

test("a job without a cancel hook refuses cancellation", async () => {
  const jobs = createJobs();
  const r = await jobs.run("x", () => new Promise(() => {}), { waitMs: 5 });
  assert.equal((await jobs.cancel(r.jobId)).ok, false);
  let cancelled = false;
  const c = await jobs.run("y", () => new Promise(() => {}), { waitMs: 5, cancel: () => { cancelled = true; } });
  assert.equal((await jobs.cancel(c.jobId)).status, "cancelled");
  assert.equal(cancelled, true);
});

test("a domain tool maps actions onto channels and classifies unknown actions as destructive", async () => {
  const calls = [];
  const tool = buildDomainTool({
    name: "netsu_test",
    summary: "test",
    actions: {
      list: { risk: "read", usage: "list()", channel: "x:list", map: async (r) => ({ n: r.length }) },
      drop: { risk: "destructive", usage: "drop(id)", channel: "x:drop", args: (a) => [a.id] },
    },
    params: { id: { type: "string" } },
  }, { invoke: async (ch, args) => { calls.push([ch, args]); return ch === "x:list" ? [1, 2] : true; }, jobs: createJobs() });
  assert.equal(tool.riskFor({ action: "list" }), "read");
  assert.equal(tool.riskFor({ action: "drop" }), "destructive");
  assert.equal(tool.riskFor({ action: "unheard_of" }), "destructive");
  assert.deepEqual(await tool.handler({ action: "list" }, {}), { ok: true, n: 2 });
  assert.deepEqual(await tool.handler({ action: "drop", id: "a" }, {}), { ok: true, value: true });
  assert.deepEqual(calls[1], ["x:drop", ["a"]]);
  assert.equal((await tool.handler({ action: "nope" }, {})).ok, false);
});

test("the permission gate applies a per-call mode and expires unanswered prompts", async () => {
  const events = [];
  const perms = createPermissions({ broadcast: (ch, p) => events.push({ ch, p }) });
  perms.setMode("auto");
  const denied = await perms.check("external", { name: "t", input: {}, risk: "write" }, { mode: "read-only" });
  assert.equal(denied.approved, false);
  const expired = await perms.check("external", { name: "t", input: {}, risk: "destructive" }, { mode: "ask", timeoutMs: 20 });
  assert.equal(expired.approved, false);
  assert.ok(events.some((e) => e.ch === "chat:approval" && e.p.runId === "external"));
  assert.ok(events.some((e) => e.ch === "chat:approval:expired"));
  // The in-app mode is untouched by the override.
  assert.equal((await perms.check("cli", { name: "t", input: {}, risk: "destructive" })).approved, true);
});

// --- stdio server end to end, against a fake core -------------------------------------------

function fakeCore(handlers) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        const msg = JSON.parse(body);
        seen.push({ ...msg, token: req.headers["x-nr-token"] });
        const h = handlers[msg.channel];
        const result = h ? await h(msg.args) : undefined;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(h ? { ok: true, result } : { ok: false, error: "unknown" }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

function startStdio(env) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "core", "agent", "mcp", "stdio.js")], {
    env: { ...process.env, NR_CORE_URL: "", NR_CORE_TOKEN: "", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buf = "";
  const waiting = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  let seq = 0;
  const request = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { child, request };
}

test("the stdio server finds the core through core-port.json and forwards the external surface", async (t) => {
  const core = await fakeCore({
    "agent:toolList": ([surface]) => [{ name: `tool_for_${surface}`, inputSchema: { type: "object" } }],
    "agent:toolCall": ([name, args, surface]) => ({ ok: true, name, args, surface }),
    "agent:resources": () => [{ uri: "netsurush://library", name: "library" }],
    "agent:resourceRead": ([uri]) => ({ contents: [{ uri, text: "[]" }] }),
  });
  const home = tmp("nrhome");
  fs.writeFileSync(path.join(home, "core-port.json"), JSON.stringify({ url: core.url, token: "tok", pid: process.pid }));
  const { child, request } = startStdio({ NR_HOME: home, NR_SURFACE: "" });
  t.after(() => { child.kill(); core.server.close(); });

  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.ok(init.result.capabilities.resources);
  assert.ok(init.result.instructions.length > 0);

  const tools = await request("tools/list", {});
  assert.equal(tools.result.tools[0].name, "tool_for_external");

  const call = await request("tools/call", { name: "netsu_library", arguments: { action: "list" } });
  assert.equal(call.result.structuredContent.surface, "external");
  assert.equal(core.seen.at(-1).token, "tok");

  const res = await request("resources/read", { uri: "netsurush://library" });
  assert.equal(res.result.contents[0].uri, "netsurush://library");
});

test("with no app running, a tool call answers a readable tool error", async (t) => {
  const home = tmp("empty");
  const { child, request } = startStdio({ NR_HOME: home });
  t.after(() => child.kill());
  await request("initialize", {});
  const call = await request("tools/call", { name: "x", arguments: {} });
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /not running/);
});

test("netsu_rpc rates channels by verb and refuses the ones that would widen an agent's rights", async () => {
  const rpcDomain = require("../core/agent/tools/app/rpc.js");
  assert.equal(rpcDomain.channelRisk("collections:load"), "read");
  assert.equal(rpcDomain.channelRisk("library:list"), "read");
  assert.equal(rpcDomain.channelRisk("collections:delete"), "destructive");
  assert.equal(rpcDomain.channelRisk("whatever:frobnicate"), "destructive");
  for (const c of ["chat:approval:respond", "mcp:external:set", "agent:toolCall", "chat:configure"]) assert.ok(rpcDomain.blocked(c), c);

  const calls = [];
  const tool = buildDomainTool(rpcDomain, {
    invoke: async (ch, args) => { calls.push([ch, args]); return { ok: true }; },
    jobs: createJobs(),
    channels: () => ["collections:load", "collections:delete", "mcp:external:set"],
    channelSource: (ch) => (ch === "collections:load" ? "([id]) => collectionStore.loadCollection(id)" : ""),
  });
  assert.equal(tool.riskFor({ action: "call", channel: "collections:load" }), "read");
  assert.equal(tool.riskFor({ action: "call", channel: "collections:delete" }), "destructive");
  const listed = await tool.handler({ action: "list" }, {});
  assert.deepEqual(listed.channels.collections, ["collections:delete (write)", "collections:load"]);
  assert.equal(listed.channels.mcp, undefined);
  assert.match((await tool.handler({ action: "describe", channel: "collections:load" }, {})).source, /loadCollection/);
  assert.equal((await tool.handler({ action: "call", channel: "mcp:external:set", args: [{ mode: "auto" }] }, {})).ok, false);
  await tool.handler({ action: "call", channel: "collections:load", args: ["c1"] }, {});
  assert.deepEqual(calls, [["collections:load", ["c1"]]]);
});

test("reordering a collection makes the default sort show the requested order", () => {
  const { createCollectionStore } = require("../core/collections.js");
  const store = createCollectionStore(tmp("coll"));
  const { id } = store.saveCollection({ name: "order" });
  store.addShots(id, [{ path: "a.mp4", in: 0, out: 1 }, { path: "b.mp4", in: 0, out: 1 }, { path: "c.mp4", in: 0, out: 1 }]);
  const shots = store.loadCollection(id).shots;
  const byPath = Object.fromEntries(shots.map((s) => [s.path, s.id]));
  const r = store.reorderShots(id, [byPath["c.mp4"], byPath["a.mp4"]]);
  assert.equal(r.ok, true);
  const sorted = [...store.loadCollection(id).shots].sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0)).map((s) => s.path);
  assert.deepEqual(sorted, ["c.mp4", "a.mp4", "b.mp4"]);
});

test("shot corrections and indexing of one file never overlap", async () => {
  const order = [];
  let finishIndex;
  const searchDomain = require("../core/agent/tools/app/search.js");
  const tool = buildDomainTool(searchDomain, {
    invoke: async (ch) => {
      order.push(ch);
      if (ch === "search:index") return new Promise((r) => { finishIndex = () => { order.push("index done"); r({ ok: true }); }; });
      return { ok: true };
    },
    jobs: createJobs(),
  });
  const indexing = await tool.handler({ action: "index", path: "f.mp4", waitSeconds: 0 }, {});
  assert.equal(indexing.background, true);
  const clearing = tool.handler({ action: "clear_scenes", path: "f.mp4" }, {});
  const other = await tool.handler({ action: "clear_scenes", path: "other.mp4" }, {});
  assert.equal(other.ok, true, "another file is not held back");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["search:index", "search:clearScenes"], "f.mp4 waits; other.mp4 went through");
  finishIndex();
  await clearing;
  assert.deepEqual(order, ["search:index", "search:clearScenes", "index done", "search:clearScenes"]);
});

test("a correction on an index holding overlapping shots says how to rebuild it", async () => {
  const searchDomain = require("../core/agent/tools/app/search.js");
  const tool = buildDomainTool(searchDomain, {
    invoke: async (ch) => (ch === "search:shots"
      ? { shots: [{ start_frame: 0, end_frame: 50, fps: 24 }, { start_frame: 40, end_frame: 90, fps: 24 }] }
      : { ok: true }),
    jobs: createJobs(),
  });
  const r = await tool.handler({ action: "merge_shots", path: "f.mp4", sceneIndexes: [0, 1] }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /overlapping.*forget/);
});
