import { thumbTime } from "@/lib/utils";
import { useCardMedia, type CardMedia } from "@/lib/useCardMedia";
import { type Segment } from "./cutStudioShared";

// Media of one shot card: the shared card machinery (lib/useCardMedia), keyed on the shot's range.
export function useSceneCardMedia({ seg, clipPath, ...rest }: {
  seg: Segment;
  index: number;
  clipPath: string;
  play: boolean;
  getProxy: (height?: number, token?: number, priority?: "high" | "low") => Promise<string | null>;
  bustProxy: () => void;
  peekProxy?: () => string | null;
}): CardMedia {
  return useCardMedia({ ...rest, clipPath, thumbAt: thumbTime(seg.in, seg.out) });
}
