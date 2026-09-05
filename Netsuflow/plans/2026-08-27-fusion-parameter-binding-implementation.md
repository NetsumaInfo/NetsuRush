# Fusion Parameter Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose declared HyperFrames variables as stable native Fusion controls that support both constant values and Fusion keyframe animation.

**Architecture:** The generic OpenFX plugin defines a fixed typed control bank at describe time. A binding supplies an immutable schema-to-slot map; at every render the plugin evaluates mapped controls with `getValueAtTime()` and sends canonical typed values plus a hash through the existing bridge. The service validates and applies those values through the HyperFrames adapter before seek/capture, with reinitialization as the correctness fallback and an opt-in frame-control shim as the interactive path.

**Tech Stack:** C++ OpenFX 1.4/Resolve SDK, existing NetsuFlow binary protocol, Node.js 22 CommonJS core, `@hyperframes/core` variable metadata, `@hyperframes/engine`, Node test runner, current native micro-tests.

---

## Gate

Execute after the HyperFrames H01/H02 session and alpha baseline exists. Do not
claim universal live keyframing until T10 proves variable reinjection for the
pinned HyperFrames version.

### Task 1: Define and validate the common control schema

**Files:**
- Create: `core/webMotion/controlSchema.js`
- Create: `test/webMotionControlSchema.test.cjs`

- [ ] **Step 1: Write failing schema-validation tests**

```js
test('normalizes a HyperFrames number variable', () => {
  assert.deepEqual(normalizeControl({
    id: 'speed',
    type: 'number',
    label: 'Speed',
    default: 1,
    min: 0,
    max: 3,
    step: 0.05,
    unit: 'x',
  }), {
    id: 'speed',
    valueType: 'double',
    label: 'Speed',
    defaultValue: 1,
    min: 0,
    max: 3,
    step: 0.05,
    unit: 'x',
    animatable: true,
  });
});

test('rejects non-finite numeric metadata', () => {
  assert.throws(() => normalizeControl({
    id: 'size',
    type: 'number',
    label: 'Size',
    default: Number.NaN,
  }), /finite/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test test/webMotionControlSchema.test.cjs`

Expected: FAIL because `core/webMotion/controlSchema.js` does not exist.

- [ ] **Step 3: Implement exact supported types and limits**

```js
const CONTROL_LIMITS = Object.freeze({
  maxControls: 32,
  maxIdBytes: 64,
  maxLabelBytes: 128,
  maxOptions: 32,
  maxOptionBytes: 128,
});

module.exports = {
  CONTROL_LIMITS,
  normalizeControl,
  normalizeControlSchema,
  validateControlValue,
};
```

Support `double`, explicit `integer` presentation, `boolean`, `color`,
`choice`, `point2d`, and short `string`. Reject unknown fields that would
change runtime semantics.

- [ ] **Step 4: Add enum, color, point grouping, duplicate ID, UTF-8 length, and overflow tests**
- [ ] **Step 5: Run the focused test and verify PASS**
- [ ] **Step 6: Commit if requested**

```powershell
git add core/webMotion/controlSchema.js test/webMotionControlSchema.test.cjs
git commit -m "feat: define web motion control schema"
```

### Task 2: Create stable schema-to-slot allocation

**Files:**
- Create: `core/webMotion/controlSlots.js`
- Create: `test/webMotionControlSlots.test.cjs`

- [ ] **Step 1: Write failing deterministic-allocation tests**

```js
test('keeps existing keyframed slot assignments stable', () => {
  const previous = {speed: {bank: 'double', index: 0}};
  const schema = [
    {id: 'size', valueType: 'double', priority: 0},
    {id: 'speed', valueType: 'double', priority: 10},
  ];
  assert.deepEqual(allocateSlots(schema, previous).assignments.speed, {
    bank: 'double',
    index: 0,
  });
});
```

- [ ] **Step 2: Run and verify failure**
- [ ] **Step 3: Implement fixed capacities**

```js
const BANK_CAPACITY = Object.freeze({
  double: 8,
  integer: 4,
  boolean: 4,
  color: 2,
  point2d: 2,
  choice: 4,
  string: 2,
});
```

Preserve previous valid assignments and tombstones first, then assign remaining
controls by explicit priority and stable ID. Never recycle a removed slot while
the binding may contain keyframes. Return an overflow list; never silently drop.

- [ ] **Step 4: Test reordering, removal tombstones, type change, capacity overflow, and binding copy**
- [ ] **Step 5: Run and verify PASS**

### Task 3: Describe the fixed native OpenFX control bank

**Files:**
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.hpp`
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.cpp`
- Create: `Netsuflow/openfx/tests/ControlBankTests.cpp`
- Modify: `Netsuflow/openfx/CMakeLists.txt`

- [ ] **Step 1: Add failing native tests for stable names and bank sizes**

Expected stable names:

```text
nfDouble01..nfDouble08
nfInteger01..nfInteger04
nfBoolean01..nfBoolean04
nfColor01..nfColor02
nfPoint01..nfPoint02
nfChoice01..nfChoice04
nfString01..nfString02
```

- [ ] **Step 2: Run CTest and verify the new suite fails**
- [ ] **Step 3: Define all slots during `describeInContext()`**

Each value slot must be persistent, animatable when its type/host permits it,
hidden and disabled by default, and configured to invalidate rendered output.

- [ ] **Step 4: Fetch the same stable handles during instance construction**
- [ ] **Step 5: Run native tests and verify PASS**
- [ ] **Step 6: Verify the plugin identifier remains `com.netsurush.netsuflow.generator`**

### Task 4: Fetch and apply binding control metadata

**Files:**
- Modify: `Netsuflow/openfx/src/BridgeClient.hpp`
- Modify: `Netsuflow/openfx/src/BridgeClient.cpp`
- Modify: `Netsuflow/openfx/src/Protocol.hpp`
- Modify: `Netsuflow/openfx/src/Protocol.cpp`
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.cpp`
- Modify: `Netsuflow/openfx/tests/ProtocolTests.cpp`
- Create: `Netsuflow/openfx/tests/ControlMetadataTests.cpp`

- [ ] **Step 1: Write failing parser tests for a bounded DESCRIBE response**

```json
{
  "bindingRevision": "binding-42",
  "controlSchemaRevision": "schema-7",
  "assignments": [
    {
      "id": "speed",
      "bank": "double",
      "index": 0,
      "label": "Speed",
      "hint": "Animation speed",
      "default": 1,
      "min": 0,
      "max": 3,
      "displayMin": 0,
      "displayMax": 2,
      "step": 0.05,
      "digits": 2,
      "unit": "x",
      "animatable": true
    }
  ]
}
```

- [ ] **Step 2: Test hostile counts, strings, ranges, indices, duplicates, and enum options**
- [ ] **Step 3: Add a versioned bounded DESCRIBE message/response**
- [ ] **Step 4: On binding/reload, update instance labels, hints, enabled/secret, ranges, increments, digits, and choice options**
- [ ] **Step 5: If an instance property update fails, retain numbered slots and expose a status warning; never fail rendering solely because the friendly label failed**
- [ ] **Step 6: Run native protocol/control tests**

### Task 5: Evaluate controls at render time and extend the cache key

**Files:**
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.hpp`
- Modify: `Netsuflow/openfx/src/NetsuFlowGenerator.cpp`
- Modify: `Netsuflow/openfx/src/BridgeClient.hpp`
- Modify: `Netsuflow/openfx/src/Protocol.hpp`
- Modify: `Netsuflow/openfx/src/Protocol.cpp`
- Modify: `Netsuflow/openfx/tests/ProtocolTests.cpp`
- Modify: `Netsuflow/openfx/tests/BridgeClientHarness.cpp`

- [ ] **Step 1: Write failing tests for canonical control encoding**

```cpp
ControlValue speed;
speed.id = "speed";
speed.type = ControlType::Double;
speed.doubleValue = 1.25;

REQUIRE(canonicalControlHash({speed}) ==
        canonicalControlHash({speed}));
```

Also prove `-0.0`, NaN, infinity, enum display labels, and reordered maps cannot
create ambiguous hashes.

- [ ] **Step 2: At render, read each mapped slot with `getValueAtTime(args.time)`**
- [ ] **Step 3: Encode schema revision, typed values, and canonical hash in FRAME metadata**
- [ ] **Step 4: Add schema revision and control hash to `FrameKey`**
- [ ] **Step 5: Re-run protocol hostile tests and the 10,000-request fake soak**

### Task 6: Validate and merge effective values in the Node service

**Files:**
- Create: `core/webMotion/controlValues.js`
- Create: `test/webMotionControlValues.test.cjs`
- Modify: `core/webMotion/frameCache.js`

- [ ] **Step 1: Write failing merge tests**

```js
test('instance control overrides binding default for one frame', () => {
  const effective = resolveControlValues({
    schema,
    bindingDefaults: {speed: 1, size: 100},
    instanceValues: {speed: 1.25},
  });
  assert.deepEqual(effective, {speed: 1.25, size: 100});
});
```

- [ ] **Step 2: Add failing cache tests proving different values never share an entry**
- [ ] **Step 3: Implement strict ID/type/range/enum/size validation and deterministic hashing**
- [ ] **Step 4: Include control schema/value hashes in memory, disk, in-flight, and pre-render keys**
- [ ] **Step 5: Run focused Node tests**

### Task 7: Apply controls in the HyperFrames adapter

**Files:**
- Create: `core/webMotion/engines/hyperframes/frameControls.js`
- Create: `core/webMotion/engines/hyperframes/netsuflow-runtime.js`
- Modify: `core/webMotion/engines/hyperframes/hyperframesEngine.js`
- Create: `test/webMotionHyperFramesControls.test.cjs`
- Create: `test/helpers/hyperframesControlFixture.cjs`

- [ ] **Step 1: Write three failing compatibility-mode tests**

```js
const {
  openControlFixture,
  readEncodedControlValue,
} = require('./helpers/hyperframesControlFixture.cjs');

test('session values apply before initialization', async (t) => {
  const fixture = await openControlFixture({mode: 'session'});
  t.after(() => fixture.close());
  const frame = await fixture.render({frame: 0, values: {speed: 1.25}});
  assert.equal(readEncodedControlValue(frame, 'speed'), 1.25);
});

test('frame shim applies values before seek', async (t) => {
  const fixture = await openControlFixture({mode: 'frame'});
  t.after(() => fixture.close());
  const first = await fixture.render({frame: 12, values: {size: 100}});
  const second = await fixture.render({frame: 12, values: {size: 240}});
  assert.equal(readEncodedControlValue(first, 'size'), 100);
  assert.equal(readEncodedControlValue(second, 'size'), 240);
  assert.equal(fixture.sessionInitializationCount(), 1);
});

test('legacy composition reinitializes when values change', async (t) => {
  const fixture = await openControlFixture({mode: 'reinitialize'});
  t.after(() => fixture.close());
  await fixture.render({frame: 4, values: {speed: 1}});
  const changed = await fixture.render({frame: 4, values: {speed: 2}});
  assert.equal(readEncodedControlValue(changed, 'speed'), 2);
  assert.equal(fixture.sessionInitializationCount(), 2);
});
```

Each fixture must encode effective values into known pixels.

- [ ] **Step 2: Implement `session` mode using validated HyperFrames overrides before initialization**
- [ ] **Step 3: Implement opt-in `frame` mode**

The adapter calls a page-side function before every seek:

```js
await page.evaluate((values) => {
  if (typeof window.__netsuflow?.applyControls !== 'function') {
    throw new Error('NETSUFLOW_FRAME_CONTROLS_UNAVAILABLE');
  }
  window.__netsuflow.applyControls(values);
}, effectiveValues);
```

The runtime shim owns current immutable values and dispatches a documented
`netsuflow:controls` event. Authored compositions update DOM/CSS/GSAP state
synchronously before the adapter calls the HyperFrames seek protocol.

- [ ] **Step 4: Implement `reinitialize` correctness fallback with explicit timing diagnostics**
- [ ] **Step 5: Reject a requested frame-control mode when the page has no shim instead of silently returning stale values**
- [ ] **Step 6: Run sequential/reverse/random control-value tests**

### Task 8: Add NetsuRush mapping UI

**Files:**
- Create: `src/components/webMotion/ControlMappingPanel.tsx`
- Modify the existing future binding panel from the engine-neutral integration plan.
- Modify all six locale files under `src/locales/<lang>/`.
- Create: `test/webMotionControlMappingRpc.test.cjs`

- [ ] **Step 1: Add RPC tests for schema discovery, assignment persistence, overflow, and compatibility tier**
- [ ] **Step 2: Show discovered variable, native type, slot, range, default, animation support, and warning**
- [ ] **Step 3: Allow explicit slot priority/grouping but preserve stable mappings by default**
- [ ] **Step 4: Show `Static`, `Frame controls`, or `Reinitialize` compatibility clearly**
- [ ] **Step 5: Run `npm run check:i18n`, `npm run check:core`, and `npm run build`**

### Task 9: Execute T10 in Resolve

**Files:**
- Create: `Netsuflow/tests/results/T10-YYYY-MM-DD/report.md`
- Use: `Netsuflow/tests/T10-parameter-binding.md`

- [ ] **Step 1: Record Resolve/plugin/engine/browser/schema revisions**
- [ ] **Step 2: Test constant edits for every supported type**
- [ ] **Step 3: Test keyframes and Fusion spline interpolation**
- [ ] **Step 4: Test reverse/random scrub and rapid control changes**
- [ ] **Step 5: Test save/reopen, copy/paste, binding switch, overflow, and service restart**
- [ ] **Step 6: Compare encoded frame pixels to effective values and standalone references**
- [ ] **Step 7: Record latency/memory/cache results for session, frame-shim, and reinitialize modes**
- [ ] **Step 8: Update product compatibility claims only from the report**
