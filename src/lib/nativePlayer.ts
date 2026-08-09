import { invoke } from "@tauri-apps/api/core";

export const isTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface NativePlayerStatus {
  is_playing: boolean;
  current_time: number;
  duration: number;
  volume: number;
  speed: number;
}

const call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args);

export const nativePlayer = {
  available: () => call<boolean>("player_is_available"),
  load: (path: string) => call<void>("player_load", { path }),
  play: () => call<void>("player_play"),
  pause: () => call<void>("player_pause"),
  togglePause: () => call<void>("player_toggle_pause"),
  stop: () => call<void>("player_stop"),
  seek: (position: number) => call<void>("player_seek", { position }),
  setVolume: (volume: number) => call<void>("player_set_volume", { volume }),
  setSpeed: (speed: number) => call<void>("player_set_speed", { speed }),
  setLoopFile: (enabled: boolean) => call<void>("player_set_loop_file", { enabled }),
  status: () => call<NativePlayerStatus>("player_get_status"),
  frameStep: () => call<void>("player_frame_step"),
  frameBackStep: () => call<void>("player_frame_back_step"),
  setGeometry: (x: number, y: number, width: number, height: number) =>
    call<void>("player_set_geometry", { x, y, width, height }),
  show: () => call<void>("player_show"),
  hide: () => call<void>("player_hide"),
};
