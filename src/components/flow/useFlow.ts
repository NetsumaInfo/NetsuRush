import { useCallback, useEffect, useRef, useState } from "react";

import { nr } from "@/lib/bridge";
import type { FlowState, FlowStatus, FlowVariable } from "@/lib/bridge";

/// A variable override, in the shape the composition itself declared.
///
/// Not a bare number for a suffixed variable and not a bare hex for a colour
/// that carried an alpha: the composition reads the string it wrote, and the
/// renderer restores that shape for the OpenFX node too. Keeping one convention
/// on both surfaces is what stops the node and this page disagreeing.
export type FlowVarValue = string | number | boolean;

/// The value a control should display: the override when one exists, the
/// composition's own default otherwise.
export function currentValue(variable: FlowVariable, overrides: Record<string, FlowVarValue>) {
  return Object.prototype.hasOwnProperty.call(overrides, variable.id)
    ? overrides[variable.id]
    : (variable.default as FlowVarValue);
}

/// What an untouched control holds, in override shape, so "is this dirty" is a
/// comparison between two values of the same kind rather than a guess.
export function declaredValue(variable: FlowVariable): FlowVarValue {
  if (variable.type === "number" && variable.suffix) {
    return `${String(variable.default)}${variable.suffix}`;
  }
  return variable.default as FlowVarValue;
}

const IDLE_STATUS: FlowStatus = {
  running: false, editorPort: 0, bridgePort: 0, error: "", ready: true, prerequisite: "",
};

export function useFlow() {
  const [status, setStatus] = useState<FlowStatus>(IDLE_STATUS);
  const [state, setState] = useState<FlowState | null>(null);
  const [overrides, setOverrides] = useState<Record<string, FlowVarValue>>({});
  /// Blocking work only — starting or stopping the engine. A save is NOT busy:
  /// disabling the whole Inspector while one is in flight is what made every
  /// parameter change feel like a page load. The browser editor never does it,
  /// and that is most of the difference in how the two feel.
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [frame, setFrame] = useState(0);
  /// Bumped on every accepted change. Frame URLs carry it, so the browser
  /// cannot answer a scrub with the image of a composition that no longer
  /// exists — the URL would otherwise be identical before and after an edit.
  const [revision, setRevision] = useState(0);

  // Re-armed on every mount, not only initialised once. StrictMode mounts,
  // unmounts and mounts again in development: a cleanup-only guard latches to
  // false on that first unmount and never returns, so every later setState is
  // silently dropped — the service starts and the interface never notices.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const adopt = useCallback((next: FlowState) => {
    setState(next);
    setRevision((value) => value + 1);
    setFrame((current) => Math.min(current, Math.max(0, (next.durationFrames || 1) - 1)));
  }, []);

  const refreshStatus = useCallback(async () => {
    const next = await nr.flowStatus();
    if (mounted.current) setStatus(next);
    return next;
  }, []);

  // Status only. Mounting the tab must not spawn a browser the user never
  // asked for, so nothing here starts the service. It does adopt a service that
  // is already up — reopening the tab must show the composition rather than an
  // empty editor sitting on top of a live engine.
  useEffect(() => {
    void (async () => {
      const next = await refreshStatus();
      if (!next.running || !mounted.current) return;
      try {
        const live = await nr.flowState();
        if (mounted.current) adopt(live);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refreshStatus, adopt]);

  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    setError("");
    try {
      return await work();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const start = useCallback(() => run(async () => {
    await nr.flowStart();
    await refreshStatus();
    adopt(await nr.flowState());
  }), [run, refreshStatus, adopt]);

  const stop = useCallback(() => run(async () => {
    await nr.flowStop();
    await refreshStatus();
    setState(null);
  }), [run, refreshStatus]);

  /// The composition, its overrides and its size travel together, because the
  /// service answers all three from one call and three separate saves would
  /// each rebuild the engine session.
  ///
  /// Saves coalesce rather than queue. A slider commits on release, but a
  /// colour popover and a stepper can both fire faster than the service
  /// rebuilds; only the newest request survives, so the composition ends up at
  /// the value the control was actually left on rather than replaying a trail.
  /// No `refreshStatus` either — the status cannot change because a variable
  /// did, and asking cost a second round trip on every click.
  const inFlight = useRef(false);
  const pending = useRef<null | (() => Promise<void>)>(null);

  const save = useCallback(async (patch: {
    html?: string;
    vars?: Record<string, FlowVarValue>;
    width?: number;
    height?: number;
  }) => {
    const send = async () => {
      setApplying(true);
      setError("");
      try {
        const next = await nr.flowSave({
          html: patch.html ?? state?.html ?? "",
          vars: patch.vars ?? overrides,
          ...(patch.width && patch.height ? { width: patch.width, height: patch.height } : {}),
        });
        if (mounted.current) adopt(next);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) setApplying(false);
      }
    };

    if (inFlight.current) {
      pending.current = send;
      return;
    }
    inFlight.current = true;
    try {
      await send();
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        await next();
      }
    } finally {
      inFlight.current = false;
    }
  }, [state, overrides, adopt]);

  /// The control moves now and the service catches up. Waiting for the round
  /// trip before showing the new value is what made the Inspector feel like it
  /// reloaded on every click.
  const setVariable = useCallback((id: string, value: FlowVarValue | undefined) => {
    const next = { ...overrides };
    // `undefined` is the reset: removing the key restores the composition's own
    // default, which is not the same as writing that default back into it.
    if (value === undefined) delete next[id];
    else next[id] = value;
    setOverrides(next);
    void save({ vars: next });
  }, [overrides, save]);

  const send = useCallback(() => run(() => nr.flowSend()), [run]);

  const frameUrl = useCallback(
    (index: number) => nr.flowFrameUrl(index, String(revision)),
    [revision],
  );

  return {
    status, state, overrides, busy, applying, error, frame, revision,
    setFrame, setError,
    refreshStatus, start, stop, save, setVariable, send, frameUrl,
  };
}
