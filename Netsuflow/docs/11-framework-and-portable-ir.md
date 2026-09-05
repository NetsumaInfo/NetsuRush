# Framework and portable IR option

## Conclusion

A framework can become valuable, but it should not be the first renderer and
should not pretend that arbitrary Remotion code can be losslessly translated.
The safest evolution has three levels.

## Level 1: Portable metadata

```ts
defineNetsuFlowComposition({
  id: 'main-title',
  width: 1920,
  height: 1080,
  fps: 30,
  durationFrames: 150,
  props: {
    title: {type: 'string', default: 'HELLO'},
    amount: {type: 'number', min: 0, max: 2, default: 1},
  },
  requirements: {
    alpha: true,
    network: false,
  },
});
```

This generates project validation, NetsuRush/Inspector controls, cache-safe prop
normalization, and diagnostics. HyperFrames or Remotion still renders pixels.

The concrete Fusion mapping, fixed native control bank, keyframe sampling, and
cache rules are specified in
[`12-fusion-parameter-binding.md`](12-fusion-parameter-binding.md).

## Level 2: Portable motion primitives

A constrained IR could express text/image/shape/layer, transforms, opacity,
sequences, interpolation, spring-like curves, and assets:

```json
{
  "type": "text",
  "value": "HELLO",
  "x": {
    "type": "interpolate",
    "input": [0, 30],
    "output": [-500, 0],
    "easing": "linear"
  }
}
```

Targets could include HyperFrames source, Remotion source, or a limited Fusion
node compiler. Each backend declares supported features. Unsupported constructs
fail explicitly or remain rendered by the original engine.

## Level 3: Authoring DSL/TSX

A future package could offer a React-like or declarative API that compiles to the
portable IR. This is a new authoring framework, not an importer for arbitrary
existing projects. It is justified only if users want code-authored portable
motion after the bridge proves demand.

## Importing Remotion code

The import path is a compiler-assisted migration:

```text
Remotion AST/project inventory
 -> supported pattern extraction
 -> portable IR where semantics are known
 -> HyperFrames project generation
 -> build + sampled visual comparison
 -> manual report for unsupported code
```

Babel/SWC/TypeScript AST tools can help inventory syntax. They do not reproduce
React execution, CSS layout, browser state, or arbitrary npm behavior. The
official HyperFrames migration material similarly treats conversion as guided
work with complex cases, not a universal runtime. [S-HF-REMOTION-MIGRATION]
[S-HF-REMOTION-SKILL]

## Boundary with the engine bridge

```text
optional metadata / IR / migration
              |
              v
BindingSnapshot + normalized props
              |
              v
RendererEngine (HyperFrames or Remotion)
              |
              v
common RGBA bridge -> OpenFX
```

The framework may create bindings and projects. It cannot own the OpenFX
protocol, cache correctness, or engine lifecycle.

## Development rule

Do not start Level 2 or 3 until:

- HyperFrames passes H01-H03;
- the common contract passes C01;
- props revisions are correct end to end;
- at least one real user workflow validates the bridge;
- a second engine or migration use case demonstrates that portability has value.

Level 1 metadata may begin earlier because it directly improves validation and
does not compete with rendering fidelity.
