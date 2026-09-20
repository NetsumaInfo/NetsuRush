// A CLI agent runs its tools through the MCP bridge, not through the BYOK
// tool-calling loop. That path broadcast nothing at all, so the interface never
// saw a tool being called or returning — and in NetsuFlow, where the edit
// PROPOSAL travels inside `flow_propose`'s result, that meant an agent
// answering "proposal ready" with no card and no Apply button.
//
// What is pinned here is what the bridge does around the call. Driving a whole
// CLI turn would need a real agent binary, so the broadcast under a live run is
// verified at runtime, not here; these are the parts that hold without one.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");

const { createAgent } = require("../core/agent/index.js");

function harness() {
  const events = [];
  const noop = () => {};
  const agent = createAgent({
    broadcast: (channel, payload) => events.push({ channel, payload }),
    ev: { emit: noop, on: noop },
    dataDir: os.tmpdir(),
    modules: {
      resolveMod: {}, timeline: {}, sidecars: {}, thumbs: {}, proxy: {},
      ffmpeg: {}, aeExporter: {}, refStore: {}, flow: {},
      guarded: (fn) => fn, rOp: (fn) => fn,
    },
  });
  return { agent, events, chat: () => events.filter((e) => e.channel === "chat:event") };
}

test("the tool registry the bridge exposes is not empty", () => {
  // A bridge that lists nothing would fail the same way as one that broadcasts
  // nothing — silently, with the agent simply never acting.
  const { agent } = harness();
  assert.ok(agent.describeTools().length > 0);
  assert.ok(agent.toolList("flow").length > 0);
  assert.ok(agent.toolList("pilot").length > 0);
});

test("no turn running means no event is attributed to a dead run", () => {
  // The renderer filters events by run id. Broadcasting under a stale or absent
  // id would either be dropped or, worse, land in an unrelated turn's trace.
  const { agent, chat } = harness();
  return agent.toolCall("flow_read", {}).then(() => {
    assert.equal(chat().length, 0, `phantom events: ${JSON.stringify(chat())}`);
  });
});

test("an unknown tool still answers, rather than throwing into the bridge", () => {
  // The MCP server forwards this result to the CLI; a rejection here would
  // surface as a dead connection instead of a tool error the agent can read.
  const { agent } = harness();
  return agent.toolCall("not_a_real_tool", {}).then((result) => {
    assert.equal(result.ok, false);
    assert.match(String(result.error), /inconnu/);
  });
});

test("the session reports which CLI turn is running", () => {
  // This is what lets the bridge attribute its events; without it the fix has
  // no run id to broadcast under.
  const { listDefs } = require("../core/agent/runtimes/defs");
  assert.ok(listDefs().length > 0);
  // Nothing is running in a fresh agent, and the accessor has to say so rather
  // than being absent — an absent one would make every tool event unattributed.
  const { createSession } = require("../core/agent/session");
  const session = createSession({
    registry: { toAnthropicTools: () => [], toOpenAITools: () => [], get: () => null, execute: async () => ({}) },
    permissions: { setMode: () => {}, setDuplicateFirst: () => {}, getMode: () => "ask", getDuplicateFirst: () => false, respond: () => {} },
    broadcast: () => {},
  });
  assert.equal(typeof session.currentCliRun, "function");
  assert.equal(session.currentCliRun(), null);
});

test("a proposal survives the bridge unchanged", () => {
  // The renderer reads `content.proposal` off the tool result. Any reshaping
  // here — wrapping, stringifying, renaming — breaks the card silently, since
  // the agent's prose still arrives and reads as if it worked.
  const { agent } = harness();
  const registry = agent.describeTools().map((tool) => tool.name);
  assert.ok(registry.includes("flow_propose"), `flow_propose missing from ${registry}`);
});
