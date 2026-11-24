import type { SourceDescriptor } from "@misonos/sonos-protocol";

type SourceInfo = Pick<SourceDescriptor, "id" | "name" | "capabilities">;

/**
 * The sources "This device" can't play, with why, by source id: those that play only
 * through the speakers (Spotify goes through Sonos's own Spotify link, so there's no stream).
 */
export function speakerOnlySources(sources: SourceInfo[]): Record<string, string> {
  return Object.fromEntries(sources
    .filter((source) => source.capabilities?.includes("sonos-only"))
    .map((source) => [source.id, `${source.name} plays only on Sonos speakers: pick a room`]));
}

/** The source Music shows: the chosen one, or, while that one can't play here, the first that can. */
export function shownSourceId(sources: SourceInfo[], chosen: string | null, blocked: Record<string, string>): string | null {
  if (!chosen || !blocked[chosen]) return chosen;
  return sources.find((source) => !blocked[source.id])?.id ?? chosen;
}
