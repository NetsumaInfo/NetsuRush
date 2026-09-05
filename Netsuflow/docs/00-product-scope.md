# Product scope

## Product statement

NetsuFlow lets a user register a HyperFrames project in NetsuRush and use one of
its compositions as a connectable image-generating node in Fusion. Fusion
requests time; NetsuFlow returns the matching visual frame with alpha.

HyperFrames is the first supported engine. Remotion is a planned second engine
behind the same binding and frame contract. The product is therefore
engine-neutral internally while its first user-facing workflow is deliberately
HyperFrames-first.

The interaction reference remains Shadertoy for Resolve: source code and
controls drive an image inside one OFX node. It demonstrates the desired shape,
not browser-backed performance. [S-VIDEO-SHADERTOY] [S-PRODUCT-SHADERTOY]

## Primary workflow

1. Install NetsuRush and the NetsuFlow integration.
2. Register or create a HyperFrames project in NetsuRush.
3. Select a composition and edit its public inputs.
4. Insert the single `NetsuFlow` OFX Generator.
5. Assign the NetsuRush-managed binding.
6. Scrub or render; the node requests the exact frame.
7. Connect Color Corrector, Glow, Merge, and normal Fusion tools after it.

A full project is the primary compatibility unit. Pasteable source can exist as
a managed snippet project, but arbitrary code still needs assets, dependencies,
fonts, build configuration, and an explicit trust decision.

## First product promise

- One engine-neutral Fusion source node.
- HyperFrames rendering without native-node translation.
- Frame-addressable output with alpha.
- Persistent browser/page sessions and bounded caching.
- Project, composition, props, reload, status, and diagnostics in NetsuRush.
- Live, Auto, and Pre-render strategies that preserve identical intended pixels.
- Windows first; macOS only after real-host validation.

## Non-goals

- Universal conversion into native Fusion nodes.
- JavaScript-to-Python/Lua transpilation.
- Reimplementing browser layout in Resolve.
- Runtime conversion from Remotion to HyperFrames as a requirement.
- Audio from the OFX Generator; pre-render/import can carry audio.
- A general public framework before the renderer bridge is proven.

## Framework option

A framework remains a valid later layer, but its first useful form is portable
metadata rather than a new rendering language:

- composition ID, dimensions, fps, duration;
- typed parameters, defaults, ranges, and assets;
- deterministic-input and network declarations;
- engine capabilities and fallback policy.

That metadata can generate NetsuRush controls for HyperFrames and Remotion
without translating pixels or component trees. A DSL/TSX authoring framework is
considered only after the same engine contract works with two real adapters.

## Success criteria

- A representative HyperFrames project renders without source modification.
- Random frame requests return the intended frame, including alpha.
- Cache hits feel immediate and misses stay bounded.
- Resolve remains stable when the renderer is slow, malformed, or restarted.
- Switching a binding from HyperFrames to a later Remotion adapter does not
  require another OpenFX binary or a different wire protocol.
- NetsuRush can install, repair, update, and remove the integration predictably.

