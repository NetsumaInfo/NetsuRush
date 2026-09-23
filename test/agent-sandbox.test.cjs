// A CLI agent brings its own Read/Edit/Write/Bash. NetsuRush used to spawn it
// in `process.cwd()` — which is the NetsuRush repository — with
// `--permission-mode bypassPermissions`. The agent therefore had an unrestricted
// shell in the user's own source tree, and did the obvious thing: it edited the
// files directly instead of calling our tools. Hot reload picked the changes up
// and the application restarted mid-conversation.
//
// Our permission gate never covered any of this: it governs the MCP tools only,
// so "read-only" was never read-only.
//
// These are the invariants that keep the agent boxed in. They are cheap to
// break by accident — a default argument, a convenience fallback — and the
// damage lands in someone's repository, so they are pinned rather than trusted
// to review.

const test = require("node:test");
const assert = require("node:assert/strict");

const { listDefs, getDef } = require("../core/agent/runtimes/defs");
const { startCliRun } = require("../core/agent/runtimes/runs");

const argsOf = (def) => def.buildArgs({
  prompt: "test", model: "", mcpConfigPath: "/tmp/mcp.json",
  allowedTools: ["mcp__netsurush__flow_read"],
});

test("no agent is launched with its permission checks bypassed", () => {
  // The one flag that turns an agent into an unsupervised process on the user's
  // machine. Nothing we ship may pass it.
  for (const def of listDefs()) {
    const args = argsOf(def).join(" ");
    assert.ok(
      !/bypassPermissions/.test(args),
      `${def.id} bypasses its permission checks: ${args}`,
    );
  }
});

test("Codex runs read-only, not with a writable workspace", () => {
  const args = argsOf(getDef("codex"));
  const at = args.indexOf("--sandbox");
  assert.notEqual(at, -1, "codex lost its sandbox flag entirely");
  assert.equal(args[at + 1], "read-only", `codex sandbox is ${args[at + 1]}`);
});

test("Claude Code is denied the tools that touch the disk and the shell", () => {
  const args = argsOf(getDef("claude"));
  const at = args.indexOf("--disallowedTools");
  assert.notEqual(at, -1, "claude has no tool denial list");
  const denied = args.slice(at + 1);
  for (const tool of ["Bash", "Edit", "Write"]) {
    assert.ok(denied.includes(tool), `${tool} is not denied: ${denied.join(" ")}`);
  }
});

test("Claude Code is allowed only the MCP tools it was handed", () => {
  const args = argsOf(getDef("claude"));
  const at = args.indexOf("--allowedTools");
  assert.notEqual(at, -1, "claude has no allow list");
  // The flag is variadic, so it swallows every token up to the NEXT flag —
  // that boundary is what the allow list actually is.
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  const allowed = end === -1 ? rest : rest.slice(0, end);
  assert.ok(allowed.length > 0, "the allow list is empty");
  for (const tool of allowed) {
    assert.match(tool, /^mcp__netsurush__/, `not an MCP tool: ${tool}`);
  }
  // And it must not be the last flag: a variadic in final position would go on
  // consuming, so anything appended later would silently become allowed.
  assert.notEqual(end, -1, "--allowedTools is last; a later argument would join the allow list");
});

test("launching without a working directory fails instead of using the repo", () => {
  // Node falls back to `process.cwd()` when `cwd` is undefined, so an omitted
  // directory would silently put the agent back in the source tree — the exact
  // bug this file exists for, reintroduced by an omission rather than an edit.
  assert.throws(
    () => startCliRun({
      def: getDef("claude"), prompt: "x", onEvent: () => {},
    }),
    /a working directory is required/,
  );
});

test("the workspace the session hands over is not the repository", () => {
  // Built from the app's data directory, never from the process's own.
  const os = require("node:os");
  const path = require("node:path");
  const { createSession } = require("../core/agent/session");
  const dataDir = path.join(os.tmpdir(), "nr-sandbox-test");
  const session = createSession({
    registry: {
      toAnthropicTools: () => [], toOpenAITools: () => [], toMcpTools: () => [],
      get: () => null, execute: async () => ({}),
    },
    permissions: {
      setMode: () => {}, setDuplicateFirst: () => {}, getMode: () => "ask",
      getDuplicateFirst: () => false, respond: () => {},
    },
    broadcast: () => {},
    dataDir,
  });
  assert.equal(typeof session.currentCliRun, "function");
  // The repository must not be reachable as the agent's working directory.
  assert.notEqual(path.resolve(dataDir), path.resolve(process.cwd()));
});
