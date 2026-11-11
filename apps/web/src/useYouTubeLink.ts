import { useCallback, useEffect, useRef, useState } from "react";
import type { YouTubeImportJob, YouTubeImportStatus, YouTubeLinkPreview } from "@misonos/sonos-protocol";
import { bridgeApi } from "./api.js";
import { describeLink, linkVideoId, visibleName, youtubeLinkKind } from "./youtube.js";

// A YouTube link pasted into the search box: play it now, streamed through the YouTube
// Music source and saved nowhere, or download it into Navidrome through Downtify. A
// single video can be downloaded under an artist and title of your own; empty fields
// keep YouTube's. The choice sits next to the box and is remembered on this device.
//
// Self-contained so it can move with the search box: useYouTubeLink holds the state
// (the search form's Enter calls its submit), YouTubeLinkPanel draws it.

export type YouTubeLinkAction = "play" | "download";

export const YOUTUBE_ACTION_KEY = "misonos:youtubeLinkAction";
// How long "Playing it on …" stays once the box has emptied.
const PLAYED_NOTE_MS = 8_000;
// Downtify looks the video up (yt-dlp); wait for the paste to settle first.
const PREVIEW_DELAY_MS = 300;

export interface YouTubeLinkOptions {
  /** The pasted link; empty when the search box holds anything else. */
  url: string;
  status: YouTubeImportStatus | null;
  /** The Sonos room to play on; unset for "This device", which can't play a link. */
  groupId?: string;
  groupName?: string;
  /** A download started: its progress shows under the box (describeImport). */
  onJob: (job: YouTubeImportJob) => void;
  /** It's playing or downloading: the search box empties. */
  onStarted: () => void;
}

export interface YouTubeLinkNote {
  text: string;
  tone: "hint" | "info" | "error";
}

export interface YouTubeLinkController {
  url: string;
  action: YouTubeLinkAction;
  setAction: (action: YouTubeLinkAction) => void;
  artist: string;
  setArtist: (artist: string) => void;
  title: string;
  setTitle: (title: string) => void;
  /** YouTube's own names, once Downtify has looked the video up. */
  preview: YouTubeLinkPreview | null;
  /** The artist and title fields show: a single video, being downloaded. */
  namesOpen: boolean;
  /** One line on what the button will do, or how the last try went. */
  note: YouTubeLinkNote | null;
  busy: boolean;
  submit: () => Promise<void>;
  dismissNote: () => void;
}

function readAction(): YouTubeLinkAction {
  try {
    return window.localStorage.getItem(YOUTUBE_ACTION_KEY) === "play" ? "play" : "download";
  } catch {
    return "download";
  }
}

function saveAction(action: YouTubeLinkAction): void {
  try {
    window.localStorage.setItem(YOUTUBE_ACTION_KEY, action);
  } catch {
    // Private mode: the choice just isn't remembered.
  }
}

function isPreview(value: unknown): value is YouTubeLinkPreview {
  return Boolean(value && typeof value === "object" && typeof (value as YouTubeLinkPreview).kind === "string");
}

export function useYouTubeLink({ url, status, groupId, groupName, onJob, onStarted }: YouTubeLinkOptions): YouTubeLinkController {
  const [action, setActionState] = useState<YouTubeLinkAction>(readAction);
  const [artist, setArtist] = useState("");
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<YouTubeLinkPreview | null>(null);
  const [result, setResult] = useState<YouTubeLinkNote | null>(null);
  const [busy, setBusy] = useState(false);
  const playedTimer = useRef<number | undefined>(undefined);

  const kind = url ? youtubeLinkKind(url) : undefined;
  const videoId = url ? linkVideoId(url) : undefined;
  const namesOpen = Boolean(url) && action === "download" && kind === "video";

  // A new link starts over: its own fields, its own names. "Playing it on …" outlives
  // the box emptying; nothing else does.
  useEffect(() => {
    setArtist("");
    setTitle("");
    setPreview(null);
    setResult((current) => (!url && current?.tone === "info" ? current : null));
    if (!url || youtubeLinkKind(url) !== "video") return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void bridgeApi.youtubePreview(url)
        .then((found) => { if (!cancelled && isPreview(found)) setPreview(found); })
        .catch(() => undefined);
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [url]);

  useEffect(() => () => window.clearTimeout(playedTimer.current), []);

  const setAction = useCallback((next: YouTubeLinkAction) => {
    setActionState(next);
    saveAction(next);
    setResult(null);
  }, []);

  // Why the chosen action can't happen, if it can't.
  let blocked: string | undefined;
  if (action === "play") {
    if (!videoId) blocked = "Play takes a single video. Download gets the whole playlist.";
    else if (!groupId) blocked = "Pick a Sonos room to play it on: this device can't play YouTube links.";
  } else if (!status?.paired) {
    blocked = "Pair MiSonos with Downtify in Settings → YouTube links to download.";
  }

  let hint = "";
  if (!url) hint = "";
  else if (blocked) hint = blocked;
  else if (action === "play") hint = `Plays it on ${groupName ?? "the room"} from YouTube, without saving it.`;
  else {
    hint = describeLink(url, { play: Boolean(groupId), playlist: status?.playlist ?? "YouTube", mixSongs: status?.mixSongs ?? 0 });
    // YouTube's name is too long for a file or prints as nothing, and nothing typed
    // replaces it: say what the download is saved as instead.
    const shortened = preview?.shortenedTo;
    const replaced = (shortened?.artist && !artist.trim()) || (shortened?.title && !title.trim());
    if (namesOpen && shortened && replaced) {
      const savedAs = [
        artist.trim() || shortened.artist || visibleName(preview?.artist),
        title.trim() || shortened.title || visibleName(preview?.title)
      ].filter(Boolean).join(" - ");
      hint += ` YouTube's name can't be used as a file name, so it's saved as “${savedAs}” unless you give it one.`;
    }
  }
  const note: YouTubeLinkNote | null = result ?? (hint ? { text: hint, tone: "hint" } : null);

  const submit = useCallback(async () => {
    if (!url || busy) return;
    if (blocked) {
      setResult({ text: blocked, tone: "error" });
      return;
    }
    setBusy(true);
    try {
      if (action === "play" && groupId) {
        await bridgeApi.playYouTube({ url, groupId });
        window.clearTimeout(playedTimer.current);
        setResult({ text: `Playing it on ${groupName ?? "the room"}, straight from YouTube.`, tone: "info" });
        playedTimer.current = window.setTimeout(() => setResult((current) => (current?.tone === "info" ? null : current)), PLAYED_NOTE_MS);
        onStarted();
      } else {
        const names = namesOpen
          ? { ...(artist.trim() ? { artist: artist.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}) }
          : {};
        onJob(await bridgeApi.importYouTube({ url, groupId, ...names }));
        setResult(null);
        onStarted();
      }
    } catch (err) {
      const fallback = action === "play" ? "Couldn't play it" : "Couldn't start the download";
      setResult({ text: err instanceof Error ? err.message : fallback, tone: "error" });
    } finally {
      setBusy(false);
    }
  }, [url, busy, blocked, action, groupId, groupName, namesOpen, artist, title, onJob, onStarted]);

  return {
    url,
    action,
    setAction,
    artist,
    setArtist: (value) => { setArtist(value); setResult(null); },
    title,
    setTitle: (value) => { setTitle(value); setResult(null); },
    preview,
    namesOpen,
    note,
    busy,
    submit,
    dismissNote: () => setResult(null)
  };
}

