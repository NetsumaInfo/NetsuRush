# System architecture

## Process model

```text
Tauri / React renderer
  NetsuFlow Studio UI
          |
          | existing typed RPC + SSE
          v
Persistent NetsuRush Node core
  core/webMotion/editor/
    project registry
    asset catalog
    editor sessions
    change sets and history
    publish coordinator
    agent context/tools
          |
          +-------------------- Resolve Python bridge
          |                       Media Pool / timeline
          |
          +-------------------- engine worker boundary
                                  HyperFrames first
                                  Remotion later
          |
          +-------------------- existing frame service
                                  binding/cache/OpenFX
```

NetsuRush remains a standalone companion. User code and browsers do not run in
the OpenFX process or the Tauri Rust shell. [ST-NR-ARCH] [ST-NF-OFX]

## Common editor domain

The common layer is intentionally smaller than a universal motion IR.

```ts
type EditorEngineId = "hyperframes" | "remotion";

interface EditorProjectRef {
  id: string;
  engine: EditorEngineId;
  rootPath: string;
  revision: string;
}

interface CompositionSummary {
  id: string;
  name: string;
  sourcePath: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  capabilities: EditorCapabilities;
}

interface EditorCapabilities {
  preview: boolean;
  code: boolean;
  variables: boolean;
  elementSelection: boolean;
  canvasTransform: boolean;
  clipTimeline: boolean;
  keyframes: boolean;
  liveBinding: boolean;
  renderedPublish: boolean;
}

interface AssetRef {
  id: string;
  origin: "project" | "resolve" | "filesystem" | "managed-proxy";
  mediaId?: string;
  sourcePath?: string;
  projectPath?: string;
  mediaType: "video" | "audio" | "image";
  availability: "ready" | "offline" | "proxy-required" | "unsupported";
}
```

The capabilities object prevents the UI from assuming that every source can be
edited visually.

## Adapter contract

```ts
interface EditorEngineAdapter {
  readonly id: EditorEngineId;
  probe(project: EditorProjectRef): Promise<EngineProbe>;
  listCompositions(project: EditorProjectRef): Promise<CompositionSummary[]>;
  openSession(input: OpenEditorSession): Promise<EditorSession>;
  getSource(sessionId: string, sourcePath: string): Promise<SourceSnapshot>;
  applyChangeSet(sessionId: string, changeSet: EditorChangeSet): Promise<ApplyResult>;
  preview(sessionId: string, frame: number): Promise<PreviewFrame>;
  validate(sessionId: string): Promise<Diagnostic[]>;
  render(sessionId: string, request: RenderRequest): Promise<RenderArtifact>;
  createBinding(sessionId: string, request: BindingRequest): Promise<BindingSnapshot>;
  closeSession(sessionId: string): Promise<void>;
}
```

Preview transport may be a Player URL, a frame buffer, or both. The UI consumes
capabilities and typed results rather than importing engine packages directly.

## Session and revision rules

- One editor session has an immutable base source revision.
- Every applied change set creates a new revision.
- Preview and render identify the exact source, override, asset, and variable
  revisions they use.
- File-watcher changes that do not descend from the session revision create a
  conflict state; they are never overwritten automatically.
- OpenFX bindings reference committed project revisions, not unsaved UI state,
  unless the user explicitly enables a temporary preview binding.
- Recovery data records base revision, patches, and last known source hashes.

## Proposed file ownership

Implementation begins only after the evidence roadmap passes.

```text
core/webMotion/editor/
  contracts.js           runtime validation and canonical shapes
  projectRegistry.js     trusted project roots and revisions
  assetCatalog.js        project/Resolve/proxy asset references
  sessionManager.js      editor lifecycle and conflict detection
  changeSets.js          validate/apply/invert staged changes
  publishCoordinator.js  live binding and rendered delivery
  agent/                 redesigned domain agent
  engines/
    hyperframes/         SDK/Studio/Player integration
    remotion/            future adapter

src/components/web-motion/
  WebMotionStudio.tsx
  StudioHeader.tsx
  ProjectPanel.tsx
  MediaPoolPanel.tsx
  PreviewPanel.tsx
  TimelinePanel.tsx
  InspectorPanel.tsx
  SourcePanel.tsx
  AgentPanel.tsx

src/store/webMotion.ts
```

Every new RPC is still registered in `core/rpc.js`, `src/lib/coreClient.ts`, and
the mock in `src/lib/bridge.ts`. [ST-NR-ARCH]

## Preview boundary

The preview runs in an isolated iframe or Player surface served from the
tokenized loopback project server. It cannot navigate the top-level Tauri view,
read unrestricted filesystem paths, or access core RPC credentials.

Canvas pointer operations are converted into typed editor operations. The
iframe never writes project files directly.

## Relationship to the current OpenFX bridge

Studio creates and updates the same immutable bindings already designed for the
OpenFX extension. It does not introduce a second frame protocol or a
Studio-specific plugin. The publish coordinator calls the common binding
registry and invalidation path. [ST-NF-OFX]

