# T05: Cross-engine contract

## Question

Can a Remotion adapter be added without changing generic Studio, Resolve,
publish, asset, and OpenFX contracts?

## Phase A: Stub

Implement a deterministic fake Remotion adapter with limited capabilities.
Run project selection, preview, props, code, render, binding, publish-record, and
agent proposal tests. Verify the UI disables unsupported visual/timeline actions
from capability data rather than engine-name branches.

## Phase B: Real minimal Remotion

Use a pinned fixture with:

- one composition;
- declared input props;
- Player preview;
- arbitrary frame render;
- transparent element;
- one media asset;
- backward and out-of-order seeks.

## Forbidden changes

- no new OpenFX identifier or protocol branch;
- no `if engine === remotion` in Resolve/media/publish modules;
- no HyperFrames DOM identifiers in common contracts;
- no automatic HTML-to-TSX translation requirement.

## Pass

All engine differences stay in the adapter and engine-specific UI providers.
The common shell, asset catalog, change-set envelope, publish records, Resolve
bridge, and OpenFX frame contract remain unchanged.

