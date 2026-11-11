import { ArrowRight, Download, Play, X } from "lucide-react";
import type { YouTubeLinkController } from "./useYouTubeLink.js";
import { visibleName } from "./youtube.js";

// The play-or-download choice for a pasted YouTube link; its state is useYouTubeLink.

/** The play-or-download choice for a pasted link, drawn under the search box. */
export function YouTubeLinkPanel({ controller }: { controller: YouTubeLinkController }) {
  const { url, action, note, busy, namesOpen, preview } = controller;
  const noteLine = note ? (
    <p className={`youtube-import-line ${note.tone}`} role="status">
      <span>{note.text}</span>
      {!url ? (
        <button type="button" className="icon-button compact" aria-label="Dismiss" onClick={controller.dismissNote}>
          <X size={14} />
        </button>
      ) : null}
    </p>
  ) : null;
  // Once the box has emptied, only how it went is left to say.
  if (!url) return noteLine;

  const shortened = preview?.shortenedTo;
  return (
    <form
      className="youtube-link-panel"
      aria-label="YouTube link"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.submit();
      }}
    >
      <div className="youtube-link-row">
        <div className="youtube-link-toggle" role="group" aria-label="Play or download the link">
          <button type="button" aria-pressed={action === "play"} onClick={() => controller.setAction("play")}>
            <Play size={15} aria-hidden="true" />
            <span>Play</span>
          </button>
          <button type="button" aria-pressed={action === "download"} onClick={() => controller.setAction("download")}>
            <Download size={15} aria-hidden="true" />
            <span>Download</span>
          </button>
        </div>
        <button type="submit" className="youtube-link-go" disabled={busy} aria-label={action === "play" ? "Play the link" : "Download the link"}>
          <span>{busy ? "Starting…" : "Go"}</span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      </div>
      {namesOpen ? (
        <div className="youtube-link-names">
          <label>
            <span>Artist</span>
            <input
              type="text"
              value={controller.artist}
              onChange={(event) => controller.setArtist(event.target.value)}
              placeholder={shortened?.artist ?? visibleName(preview?.artist) ?? "YouTube's channel"}
              autoComplete="off"
              maxLength={200}
            />
          </label>
          <label>
            <span>Title</span>
            <input
              type="text"
              value={controller.title}
              onChange={(event) => controller.setTitle(event.target.value)}
              placeholder={shortened?.title ?? visibleName(preview?.title) ?? "YouTube's title"}
              autoComplete="off"
              maxLength={200}
            />
          </label>
        </div>
      ) : null}
      {noteLine}
    </form>
  );
}
