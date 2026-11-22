// Parallel sub-agents: the concurrency limit is a setting and holds across dispatches, a caller asks
// for a tier that resolves on whichever CLI is installed, a sub-agent starts bare (no built-in tools,
// none of the user's MCP servers or settings), and its rights are fixed by the surface it was spawned
// with. A real `claude` was driven at runtime; Codex never was, for want of a subscription.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSubagents, subagentAllows, codexModel, TOOLS } = require("../core/agent/subagents.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nr-sub-"));

function harness(settings = { maxSubagents: 2 }, installed = ["claude"]) {
  const live = [];
  const started = [];
  let peak = 0;
  const events = [];
  const start = (opts) => {
    started.push(opts);
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const run = {
      opts,
      child: { kill: () => { run.killed = true; run.end(); } },
      end: (answer = "done") => {
        if (run.ended) return;
        run.ended = true;
        live.splice(live.indexOf(run), 1);
        opts.onEvent({ type: "text", delta: "thinking about it" });
        opts.onEvent({ type: "tool_use", id: "1", name: "x", input: {} });
        opts.onEvent({ type: "usage", inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
        opts.onEvent({ type: "text", delta: answer });
        opts.onEvent({ type: "done", stopReason: "end" });
        finish();
      },
    };
    live.push(run);
    peak = Math.max(peak, live.length);
    return { child: run.child, done };
  };
  const h = { probes: 0 };
  const subs = createSubagents({
    workspace: () => workspace,
    mcpConfigPath: (surface) => `config-${surface}.json`,
    settings: () => settings,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    start,
    detect: async () => {
      h.probes += 1;
      return ["claude", "codex", "gemini"].map((id) => ({ id, available: installed.includes(id) }));
    },
  });
  return Object.assign(h, { subs, live, started, peak: () => peak, events, settings });
}
const workspace = tmp();
const tick = () => new Promise((r) => setTimeout(r, 5));

test("no more than the configured number run at once, the rest queue", async () => {
  const h = harness({ maxSubagents: 2 });
  const running = h.subs.dispatch({ tasks: [1, 2, 3, 4, 5].map((n) => ({ prompt: `job ${n}` })) });
  await tick();
  assert.equal(h.live.length, 2);
  assert.deepEqual(await h.subs.status(), { max: 2, running: 2, queued: 3, engine: "claude" });
  while (h.live.length) { h.live[0].end(); await tick(); }
  const r = await running;
  assert.equal(h.peak(), 2);
  assert.equal(r.total, 5);
  assert.equal(r.failed, 0);
});

test("the limit is a setting, not a constant: raising it takes effect", async () => {
  const h = harness({ maxSubagents: 20 });
  const running = h.subs.dispatch({ tasks: Array.from({ length: 12 }, (_, n) => ({ prompt: `job ${n}` })) });
  await tick();
  assert.equal(h.live.length, 12);
  while (h.live.length) h.live[0].end();
  await running;
});

test("the queue is shared by every dispatch", async () => {
  const h = harness({ maxSubagents: 1 });
  const a = h.subs.dispatch({ prompt: "first" });
  const b = h.subs.dispatch({ prompt: "second" });
  await tick();
  assert.equal(h.live.length, 1);
  h.live[0].end(); await tick();
  assert.equal(h.live.length, 1);
  h.live[0].end();
  await Promise.all([a, b]);
});

test("a report keeps the last answer and adds up the cost", async () => {
  const h = harness();
  const running = h.subs.dispatch({ tasks: [{ name: "scout", prompt: "look" }] });
  await tick();
  h.live[0].end('{"file":"a.mp4","inFrame":1,"outFrame":2}');
  const r = await running;
  assert.equal(r.results[0].name, "scout");
  assert.equal(r.results[0].answer, '{"file":"a.mp4","inFrame":1,"outFrame":2}');
  assert.equal(r.results[0].toolCalls, 1);
  assert.equal(r.costUsd, 0.25);
});

test("one prompt spreads over files, in batches when asked", async () => {
  const h = harness({ maxSubagents: 10 });
  const running = h.subs.dispatch({ prompt: "find rain", files: ["C:/a.mp4", "C:/b.mp4", "C:/c.mp4"], filesPerAgent: 2 });
  await tick();
  assert.equal(h.started.length, 2);
  assert.match(h.started[0].prompt, /find rain[\s\S]*- C:\/a\.mp4\n- C:\/b\.mp4/);
  assert.match(h.started[1].prompt, /- C:\/c\.mp4/);
  while (h.live.length) h.live[0].end();
  await running;
});

test("the caller asks for a tier, eco by default, and no longer names a model", async () => {
  const h = harness();
  const eco = h.subs.dispatch({ prompt: "look", model: "haiku & calc" });
  await tick();
  assert.equal(h.started[0].model, "haiku", "a model argument is ignored, so it cannot reach the shell");
  h.live[0].end();
  assert.equal((await eco).tier, "eco");
  const normal = h.subs.dispatch({ prompt: "look", tier: "normal" });
  await tick();
  assert.equal(h.started[1].model, "sonnet");
  h.live[0].end();
  await normal;
  assert.equal((await h.subs.dispatch({ prompt: "look", tier: "premium" })).ok, false);
});

test("the tier resolves on what is installed: Claude Code first, else Codex, else a clear error", async () => {
  const both = harness(undefined, ["codex", "claude"]);
  const a = both.subs.dispatch({ prompt: "look" });
  await tick();
  assert.equal(both.started[0].def.id, "claude");
  both.live[0].end();
  assert.equal((await a).engine, "claude");

  const codex = harness(undefined, ["codex"]);
  const b = codex.subs.dispatch({ prompt: "look", access: "write" });
  await tick();
  const opts = codex.started[0];
  assert.equal(opts.def.id, "codex");
  assert.match(opts.model, /luna/);
  assert.equal(opts.def.promptViaStdin, true, "a prompt must not go through the shell");
  assert.match(opts.prompt, /sub-agent of NetsuRush[\s\S]*look$/, "Codex has no system prompt flag");
  const args = opts.def.buildArgs(opts);
  assert.equal(args.at(-1), "-");
  assert.ok(args.includes("--ignore-user-config"), "the user's other MCP servers stay out");
  assert.ok(args.includes("--sandbox") && args.includes("read-only"));
  assert.ok(args.some((x) => x.includes("NR_SURFACE='subagent-write'")));
  assert.ok(!args.some((x) => /TOKEN/.test(x)), "the core token stays off the command line");
  codex.live[0].end();
  await b;

  const none = harness(undefined, ["gemini"]);
  const c = await none.subs.dispatch({ prompt: "look" });
  assert.equal(c.ok, false);
  assert.match(c.error, /Claude Code or Codex/);
  assert.equal(none.started.length, 0);
});

test("how hard a sub-agent thinks is medium by default, and checked", async () => {
  const h = harness();
  const a = h.subs.dispatch({ prompt: "look" });
  await tick();
  const args = h.started[0].def.buildArgs(h.started[0]);
  assert.equal(args[args.indexOf("--effort") + 1], "medium");
  h.live[0].end();
  assert.equal((await a).effort, "medium");
  const b = h.subs.dispatch({ prompt: "look", effort: "high" });
  await tick();
  const high = h.started[1].def.buildArgs(h.started[1]);
  assert.equal(high[high.indexOf("--effort") + 1], "high");
  h.live[0].end();
  await b;
  assert.equal((await h.subs.dispatch({ prompt: "look", effort: "huge & calc" })).ok, false, "it reaches a shell");
});

test("the installed engine is not probed again on every dispatch", async () => {
  const h = harness();
  for (const prompt of ["a", "b"]) {
    const r = h.subs.dispatch({ prompt });
    await tick();
    h.live[0].end();
    await r;
  }
  assert.equal(h.probes, 1);
});

test("Codex's eco model follows its own cache, best listed first, with an offline net", () => {
  const home = tmp();
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.equal(codexModel("luna", "fallback-luna"), "fallback-luna");
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-5.6-luna", visibility: "list", priority: 9 },
      { slug: "gpt-7-luna-hidden", visibility: "hide", priority: 1 },
      { slug: "gpt-6-luna", visibility: "list", priority: 5 },
      { slug: "gpt-5.6-terra", visibility: "list", priority: 8 },
    ] }));
    assert.equal(codexModel("luna", "fallback-luna"), "gpt-6-luna");
    assert.equal(codexModel("terra", "fallback-terra"), "gpt-5.6-terra");
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved;
  }
});

test("the tool tells the agent to prefer cheap sub-agents", () => {
  const domain = require("../core/agent/tools/app/agents.js");
  assert.match(domain.summary, /PREFER CHEAP/);
  assert.deepEqual(domain.params.tier.enum, ["eco", "normal"]);
  assert.equal(domain.params.model, undefined);
});

test("nothing to do is an error the caller can read", async () => {
  assert.equal((await harness().subs.dispatch({})).ok, false);
});

test("a sub-agent starts bare, on Haiku, with the surface of its access", async () => {
  const h = harness();
  const read = h.subs.dispatch({ prompt: "look" });
  await tick();
  const opts = h.started[0];
  assert.equal(opts.model, "haiku");
  assert.equal(opts.mcpConfigPath, "config-subagent.json");
  const args = opts.def.buildArgs({ ...opts });
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--system-prompt-file"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--tools") + 1], '""');
  assert.equal(args[args.indexOf("--setting-sources") + 1], '""');
  assert.ok(!args.includes("--bare"), "--bare refuses subscription logins");
  // The spawn goes through a shell: an argument with a space must be quoted or it would be split.
  assert.ok(args.every((a) => !/\s/.test(String(a)) || /^".*"$/.test(String(a))), JSON.stringify(args));
  h.live[0].end();
  await read;

  const write = h.subs.dispatch({ prompt: "fill", access: "write", tier: "normal" });
  await tick();
  assert.equal(h.started[1].mcpConfigPath, "config-subagent-write.json");
  assert.equal(h.started[1].model, "sonnet");
  h.live[0].end();
  await write;
});

test("cancelling empties the queue and stops what runs", async () => {
  const h = harness({ maxSubagents: 1 });
  const running = h.subs.dispatch({ tasks: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }] });
  await tick();
  assert.equal(h.subs.cancelAll().stopped, 3);
  const r = await running;
  assert.equal(h.started.length, 1, "a kill must not start the next task in line");
  assert.equal(r.failed, 3);
  assert.equal(r.ok, false);
});

test("rights: read-only reads, write writes, neither deletes nor leaves the footage tools", () => {
  assert.equal(subagentAllows("subagent", "netsu_search", "read"), true);
  assert.equal(subagentAllows("subagent", "netsu_collections", "write"), false);
  assert.equal(subagentAllows("subagent-write", "netsu_collections", "write"), true);
  assert.equal(subagentAllows("subagent-write", "netsu_collections", "destructive"), false);
  assert.equal(subagentAllows("subagent-write", "netsu_rpc", "read"), false);
  assert.equal(subagentAllows("subagent-write", "netsu_agents", "write"), false, "no sub-agent dispatches sub-agents");
  assert.ok(!TOOLS.includes("netsu_agents"));
  assert.ok(!TOOLS.includes("netsu_rpc"));
});

test("the max sub-agents setting persists and stays in bounds", () => {
  const { createExternalAccess } = require("../core/agent/mcp/external.js");
  const dataDir = tmp();
  const a = createExternalAccess({ dataDir });
  assert.equal(a.get().maxSubagents, 8);
  a.set({ maxSubagents: 30 });
  assert.equal(createExternalAccess({ dataDir }).get().maxSubagents, 30);
  assert.equal(a.set({ maxSubagents: 500 }).maxSubagents, 64);
  assert.equal(a.set({ maxSubagents: 0 }).maxSubagents, 8);
});

test("the Claude Code client installs the scout agent, and never overwrites the user's own", () => {
  const home = tmp();
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    const { createExternalAccess } = require("../core/agent/mcp/external.js");
    const access = createExternalAccess({ dataDir: tmp() });
    const scout = path.join(home, ".claude", "agents", "netsu-scout.md");
    assert.equal(access.install("claude-code").ok, true);
    const body = fs.readFileSync(scout, "utf8");
    assert.match(body, /model: haiku/);
    assert.match(body, /mcp__netsurush__netsu_search/);
    assert.equal(access.uninstall("claude-code").ok, true);
    assert.equal(fs.existsSync(scout), false);

    fs.writeFileSync(scout, "my own agent");
    access.install("claude-code");
    assert.equal(fs.readFileSync(scout, "utf8"), "my own agent");
    access.uninstall("claude-code");
    assert.equal(fs.readFileSync(scout, "utf8"), "my own agent");
  } finally {
    process.env.USERPROFILE = saved.USERPROFILE;
    process.env.HOME = saved.HOME;
  }
});

test("the facade lists only the footage tools to a sub-agent and refuses the rest", async () => {
  const { createAgent } = require("../core/agent/index.js");
  const noop = () => {};
  const agent = createAgent({
    broadcast: noop, ev: { emit: noop, on: noop }, dataDir: tmp(),
    modules: { resolveMod: {}, timeline: {}, sidecars: {}, thumbs: {}, proxy: {}, ffmpeg: {}, aeExporter: {}, guarded: (fn) => fn, rOp: (fn) => fn },
    invoke: async () => [],
  });
  try {
    const names = agent.toolList("subagent").map((t) => t.name);
    assert.ok(names.includes("netsu_search"));
    assert.ok(!names.includes("netsu_agents"));
    assert.ok(agent.toolList("external").some((t) => t.name === "netsu_agents"));
    assert.equal((await agent.toolCall("netsu_rpc", { action: "list" }, "subagent")).ok, false);
    assert.equal((await agent.toolCall("netsu_collections", { action: "save", collection: {} }, "subagent")).ok, false);
    assert.equal((await agent.toolCall("netsu_collections", { action: "delete", id: "x" }, "subagent-write")).ok, false);
    assert.equal((await agent.toolCall("netsu_collections", { action: "save", collection: {} }, "subagent-write")).ok, true);
  } finally {
    agent.cancelAll();
  }
});
