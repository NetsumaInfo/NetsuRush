# Remotion-to-HyperFrames migration

## Position

Migration is an optional authoring tool, not the bridge architecture.

The official HyperFrames repository provides a Remotion migration guide and
one-way migration skill. They describe many mechanical mappings, but also
identify cases that need manual work or do not translate cleanly.
[S-HF-REMOTION-MIGRATION] [S-HF-REMOTION-SKILL]

A closed experimental pull request proposed a Remotion runtime adapter, but it
was not merged and the referenced adapter package is not present on main. It is
useful design evidence, not a dependency. [S-HF-REMOTION-ADAPTER-PR]

## Three distinct paths

1. **Direct HyperFrames:** native HyperFrames project through
   `HyperFramesEngine`.
2. **Direct Remotion:** original project through future `RemotionEngine`.
3. **Explicit migration:** generate a separate HyperFrames project, then render
   it through `HyperFramesEngine`.

Path 2 is the fidelity fallback when path 3 cannot preserve behavior.

## Possible migration pipeline

```text
Remotion source
 -> project/AST inventory
 -> supported-pattern mapping
 -> generated HyperFrames project
 -> build/type diagnostics
 -> sampled reference renders
 -> pixel/temporal comparison
 -> user review
 -> new HyperFrames binding
```

The output is editable source and a migration report. Never overwrite the
original project.

## Useful mappings

Candidate mechanical mappings include composition metadata, sequences/timing,
basic transforms, opacity, text/images, deterministic interpolation, and
portable props. Complex React hooks, custom packages, runtime data, Remotion-only
media semantics, browser side effects, and rendering-specific APIs require
manual conversion or direct Remotion rendering.

## Acceptance

A migration is accepted only if:

- the generated project builds;
- composition metadata matches;
- props mapping is explicit;
- sampled frames including boundaries match tolerance;
- alpha/time behavior passes;
- unsupported constructs are listed;
- the user chooses the new binding.

An LLM may propose edits, but tests and visual comparison are the authority.

## Framework relationship

Portable NetsuFlow metadata can make future projects easier to move between
engines. It cannot make arbitrary existing code portable. This is the safest
first “framework” investment because it improves both adapters without claiming
universal source translation.

