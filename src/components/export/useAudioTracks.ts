// Pistes audio d'une source, sondées à la volée (ffprobe côté core). Sans source → liste vide :
// le menu retombe alors sur des numéros de piste génériques.
import { useEffect, useState } from "react";
import { nr, type AudioTrack } from "@/lib/bridge";

export function useAudioTracks(sourcePath?: string): AudioTrack[] {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  useEffect(() => {
    if (!sourcePath) { setTracks([]); return; }
    let alive = true;
    nr.audioTracks(sourcePath)
      .then((r) => { if (alive) setTracks(r.tracks || []); })
      .catch(() => { if (alive) setTracks([]); });
    return () => { alive = false; };
  }, [sourcePath]);
  return tracks;
}
