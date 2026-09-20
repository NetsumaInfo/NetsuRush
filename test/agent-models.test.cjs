// The model catalogue used to be three hand-typed lists, and they had gone a
// generation stale without anything noticing — picking Codex offered models
// that no longer existed. It is fetched now, which moves the risk rather than
// removing it: the parsing, the filtering and the id translation are where a
// current list can still turn into ids the API rejects.
//
// Nothing here touches the network. The fetch is exercised by hand; what is
// pinned is what happens to the bytes once they arrive.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CURATED, MAX_MODELS,
  isChatModel, idsFromOpenAiShape, fromCatalog, majorsFirst,
} = require("../core/agent/models");
const { listDefs } = require("../core/agent/runtimes/defs");

test("transcription, speech, image and embedding models are not offered as engines", () => {
  // They come back from the same /models endpoint as the chat models, so
  // nothing but this filter keeps them out of a conversation picker — where
  // choosing one produces a failure at the first message.
  for (const id of [
    "whisper-1", "gpt-4o-transcribe", "tts-1-hd", "dall-e-3",
    "text-embedding-3-large", "omni-moderation-latest", "gpt-image-2",
    "gpt-realtime-2.1", "sora-2", "google/gemini-3-pro-image",
  ]) {
    assert.equal(isChatModel(id), false, `offered: ${id}`);
  }
});

test("chat models survive the filter, open-weight `instruct` ones included", () => {
  // `instruct` meant a completion model at OpenAI, but it is the ordinary
  // suffix of open models on OpenRouter — filtering on it emptied half the
  // catalogue.
  for (const id of [
    "claude-opus-5", "gpt-6-astra", "gpt-5.6-sol", "grok-4.6",
    "gemini-3.8-flash", "meta-llama/llama-3.3-70b-instruct",
    "qwen/qwen3-coder", "moonshotai/kimi-k3",
  ]) {
    assert.equal(isChatModel(id), true, `filtered out: ${id}`);
  }
});

test("`:batch` variants are refused, `:free` and `:thinking` are kept", () => {
  // Batch is a different API — asynchronous, no streaming — so it cannot serve
  // a conversation. The other suffixes go through the same endpoint.
  assert.equal(isChatModel("openai/gpt-6-astra:batch"), false);
  assert.equal(isChatModel("qwen/qwen3-coder:free"), true);
  assert.equal(isChatModel("anthropic/claude-opus-5:thinking"), true);
});

test("a models payload is read newest first", () => {
  const ids = idsFromOpenAiShape({
    data: [
      { id: "old-model", created: 100 },
      { id: "new-model", created: 300 },
      { id: "mid-model", created: 200 },
    ],
  });
  assert.deepEqual(ids, ["new-model", "mid-model", "old-model"]);
});

test("a payload that is not a models list yields null rather than an empty list", () => {
  // The distinction decides whether the caller falls through to the next
  // source or shows an empty dropdown: an error page parsed as JSON must not
  // read as "this provider has no models".
  assert.equal(idsFromOpenAiShape(null), null);
  assert.equal(idsFromOpenAiShape({ error: "unauthorized" }), null);
  assert.deepEqual(idsFromOpenAiShape({ data: [] }), []);
});

test("Anthropic ids are dotted on OpenRouter and dashed on its own API", () => {
  // The one vendor whose slug does not transpose. Left alone, the catalogue
  // would hand out `claude-fable-5.1`, which the Anthropic API refuses.
  const catalog = [
    "anthropic/claude-fable-5.1",
    "anthropic/claude-opus-5",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-opus-5:batch",
    "openai/gpt-6-astra",
  ];
  assert.deepEqual(fromCatalog("anthropic", catalog), [
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-haiku-4-5",
  ]);
});

test("the other vendors keep their dots on both sides", () => {
  assert.deepEqual(fromCatalog("openai", ["openai/gpt-5.6-sol"]), ["gpt-5.6-sol"]);
  assert.deepEqual(fromCatalog("google", ["google/gemini-3.8-flash"]), ["gemini-3.8-flash"]);
  // xAI publishes under `x-ai/`, not `xai`: the slug prefix and our provider
  // name do not match, and reading the prefix off the id would return nothing.
  assert.deepEqual(fromCatalog("xai", ["x-ai/grok-4.6"]), ["grok-4.6"]);
});

test("the major vendors come first, and the order within one is preserved", () => {
  const ordered = majorsFirst([
    "inclusionai/ling-3.0-flash",
    "anthropic/claude-opus-5",
    "somebody/obscure-model",
    "anthropic/claude-sonnet-5",
    "openai/gpt-6-astra",
  ]);
  assert.deepEqual(ordered.slice(0, 3), [
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "openai/gpt-6-astra",
  ]);
  // 340 usable models sorted by date alone put a model released yesterday by
  // nobody ahead of Claude and GPT, which turns a choice into a directory.
  assert.equal(ordered.length, 5);
});

test("every CLI agent draws its models from a provider the catalogue serves", () => {
  // A def naming a provider nothing can answer for would show an empty model
  // list and no error — the exact failure this whole file exists to prevent.
  const servable = new Set([...Object.keys(CURATED)]);
  for (const def of listDefs()) {
    if (!def.modelsFrom) continue;
    assert.ok(
      servable.has(def.modelsFrom),
      `${def.id}: modelsFrom "${def.modelsFrom}" is not a provider the catalogue can serve`,
    );
  }
});

test("the offline fallback covers every provider an agent can name", () => {
  for (const def of listDefs()) {
    if (!def.modelsFrom) continue;
    assert.ok(
      (CURATED[def.modelsFrom] || []).length > 0,
      `${def.id}: no offline fallback for ${def.modelsFrom}`,
    );
  }
});

test("the list is capped, so the dropdown stays a choice", () => {
  assert.ok(MAX_MODELS > 0 && MAX_MODELS <= 100, `implausible cap: ${MAX_MODELS}`);
});
