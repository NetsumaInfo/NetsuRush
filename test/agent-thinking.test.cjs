// One setting in the interface, five different writings on the wire. The
// translation is where it can silently go wrong: a wrong keyword is ignored by
// an API and the user sees a control that does nothing, a level a binary does
// not know fails the spawn, and a budget above the ceiling is rejected.
//
// The ladders below are not guesses. They were read out of each binary's own
// `--help` on 2026-09-07, which is how `xhigh` turned up at all — an earlier
// version of this file asserted that only Codex had any switch, and that was
// simply wrong about Claude Code, Copilot and Antigravity.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEVELS, DEFAULT_LEVEL, ANTHROPIC_BUDGET, ACCEPTS, THINKING_PROVIDERS, THINKING_CLI,
  normalize, clamp, bodyFor, maxTokensFor, cliArgsFor,
} = require("../core/agent/thinking");

test("the ladder is the one Claude Code accepts", () => {
  // `claude --help`: Effort level for the current session (low, medium, high,
  // xhigh, max). Every other ladder is a prefix of it.
  assert.deepEqual(LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ACCEPTS.claude, LEVELS);
});

test("there is no `off`, and a stored one lands on the default", () => {
  // A level that sent nothing read as a fault rather than as a choice; the
  // absence of a setting is the model's own default, not a rung.
  assert.ok(!LEVELS.includes("off"));
  assert.equal(normalize("off"), DEFAULT_LEVEL);
  assert.equal(DEFAULT_LEVEL, "medium");
});

test("Anthropic gets a token budget, the others a keyword", () => {
  assert.deepEqual(bodyFor("anthropic", "medium"), {
    thinking: { type: "enabled", budget_tokens: 8192 },
  });
  assert.deepEqual(bodyFor("openai", "medium"), { reasoning_effort: "medium" });
  assert.deepEqual(bodyFor("xai", "low"), { reasoning_effort: "low" });
  // OpenRouter unifies vendors behind an object; the flat key is ignored there.
  assert.deepEqual(bodyFor("openrouter", "high"), { reasoning: { effort: "high" } });
});

test("a level above a target's ceiling is clamped, never sent", () => {
  // `agy --help` stops at high. Sending `xhigh` would fail the launch, and
  // reasoning one notch lower beats not answering.
  assert.deepEqual(cliArgsFor("antigravity", "xhigh"), ["--effort", "high"]);
  assert.deepEqual(cliArgsFor("antigravity", "max"), ["--effort", "high"]);
  assert.deepEqual(bodyFor("openai", "max"), { reasoning_effort: "high" });
  // Claude Code and Copilot take the whole ladder, so nothing is lost there.
  assert.deepEqual(cliArgsFor("claude", "max"), ["--effort", "max"]);
  assert.deepEqual(cliArgsFor("copilot", "xhigh"), ["--effort", "xhigh"]);
});

test("clamping never invents a level the target does not list", () => {
  for (const [target, ladder] of Object.entries(ACCEPTS)) {
    for (const level of LEVELS) {
      assert.ok(ladder.includes(clamp(target, level)), `${target} <- ${level}`);
    }
  }
});

test("Anthropic keeps all five levels distinct", () => {
  // A budget is a number, so it does not collapse the way three keywords do.
  const budgets = LEVELS.map((l) => bodyFor("anthropic", l).thinking.budget_tokens);
  assert.equal(new Set(budgets).size, LEVELS.length, `collapsed: ${budgets}`);
  // And it is monotonic, or the labels would lie about which thinks harder.
  for (let i = 1; i < budgets.length; i++) {
    assert.ok(budgets[i] > budgets[i - 1], `${LEVELS[i]} is not above ${LEVELS[i - 1]}`);
  }
});

test("max_tokens always exceeds the thinking budget", () => {
  // The invariant Anthropic enforces: a request whose max_tokens is not
  // strictly greater than budget_tokens is refused, and the chat's own default
  // (4096) is smaller than every level.
  for (const level of LEVELS) {
    const budget = bodyFor("anthropic", level).thinking.budget_tokens;
    assert.ok(
      maxTokensFor(level, 4096) > budget,
      `${level}: max_tokens ${maxTokensFor(level, 4096)} <= budget ${budget}`,
    );
  }
});

test("a caller's larger ceiling is kept rather than lowered", () => {
  // It is a floor, not an instruction: clamping down would silently truncate a
  // long answer someone deliberately asked for.
  assert.equal(maxTokensFor("low", 200000), 200000);
});

test("every Anthropic budget clears the API's 1024 minimum", () => {
  for (const [level, budget] of Object.entries(ANTHROPIC_BUDGET)) {
    assert.ok(budget >= 1024, `${level}: ${budget} would be refused`);
  }
});

test("an unknown level falls back to the default, not through", () => {
  for (const bogus of ["ultra", "", null, undefined, "HIGH", 3]) {
    assert.equal(normalize(bogus), DEFAULT_LEVEL, String(bogus));
  }
});

test("Codex takes a config key, the rest of the flagged agents take --effort", () => {
  assert.deepEqual(cliArgsFor("codex", "high"), ["-c", "model_reasoning_effort=high"]);
  for (const agent of ["claude", "copilot", "antigravity"]) {
    assert.equal(cliArgsFor(agent, "medium")[0], "--effort", agent);
  }
  // Gemini CLI's help lists no such flag; emitting one would fail the spawn.
  for (const agent of ["gemini", "cursor", "aider", "opencode", "qwen"]) {
    assert.deepEqual(cliArgsFor(agent, "high"), [], agent);
  }
});

test("the advertised capabilities match what the mapping produces", () => {
  // The renderer hides the control for anything absent from these lists; a
  // target listed as capable but emitting nothing would show a control that lies.
  for (const provider of THINKING_PROVIDERS) {
    assert.ok(Object.keys(bodyFor(provider, "high")).length, `${provider} advertises but emits nothing`);
  }
  for (const agent of THINKING_CLI) {
    assert.ok(cliArgsFor(agent, "high").length, `${agent} advertises but emits no args`);
  }
  // And nothing outside them quietly works, which would mean a usable engine
  // whose control we hide.
  assert.deepEqual(cliArgsFor("gemini", "high"), []);
});

test("the renderer's capability list agrees with the core's", () => {
  // Two files, one truth. They drifting apart shows up as a control offered
  // where nothing is sent, or withheld where something would be.
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const source = readFileSync(join(__dirname, "..", "src", "lib", "agentCatalog.ts"), "utf8");
  const read = (name) => {
    const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    assert.ok(match, `${name} not found in agentCatalog.ts`);
    return match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  };
  assert.deepEqual(read("THINKING_CLI").sort(), [...THINKING_CLI].sort());
  assert.deepEqual(read("THINKING_PROVIDERS").sort(), [...THINKING_PROVIDERS].sort());
});
