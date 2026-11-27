// "This device": what to do when the song's stream fails. A stream that breaks off
// partway (the network dropped, the server restarted) is opened again from where it was,
// a few times per song; one that never played, or that the browser can't play, is
// skipped as before.

export const MAX_RESUMES = 4;
// MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: nothing to resume.
const SRC_NOT_SUPPORTED = 4;

export interface ResumeState {
  /** Which song the count is for: "sourceId\ntrackId". */
  key: string;
  count: number;
}

/** The next resume try (with how long to wait first), or null to skip the song. */
export function planResume(
  previous: ResumeState | null,
  key: string,
  playedSeconds: number,
  errorCode: number | undefined
): { state: ResumeState; delayMs: number } | null {
  if (playedSeconds <= 0 || errorCode === SRC_NOT_SUPPORTED) return null;
  const count = previous?.key === key ? previous.count : 0;
  if (count >= MAX_RESUMES) return null;
  // 1 s, 2 s, 3 s, 4 s: long enough together to outlast a server restart.
  return { state: { key, count: count + 1 }, delayMs: (count + 1) * 1000 };
}
