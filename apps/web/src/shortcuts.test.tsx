import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { shortcutFromEvent, useKeyboardShortcuts, type ShortcutActions } from "./shortcuts.js";

function key(init: Partial<KeyboardEvent> & { key: string }) {
  return { code: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...init };
}

describe("shortcutFromEvent", () => {
  it("names letters, digits and named keys the way aria-keyshortcuts does", () => {
    expect(shortcutFromEvent(key({ key: "k" }))).toBe("K");
    expect(shortcutFromEvent(key({ key: "N", shiftKey: true }))).toBe("Shift+N");
    expect(shortcutFromEvent(key({ key: " " }))).toBe("Space");
    expect(shortcutFromEvent(key({ key: "ArrowUp", shiftKey: true }))).toBe("Shift+ArrowUp");
    expect(shortcutFromEvent(key({ key: "Delete", shiftKey: true }))).toBe("Shift+Delete");
    expect(shortcutFromEvent(key({ key: "s", ctrlKey: true }))).toBe("Control+S");
  });

  it("reads digits off the physical key, so Shift+1 isn't '!'", () => {
    expect(shortcutFromEvent(key({ key: "1", code: "Digit1" }))).toBe("1");
    expect(shortcutFromEvent(key({ key: "!", code: "Digit1", shiftKey: true }))).toBe("Shift+1");
  });

  it("leaves Shift out of symbols, whatever key types them", () => {
    expect(shortcutFromEvent(key({ key: "?", code: "Slash", shiftKey: true }))).toBe("?");
    expect(shortcutFromEvent(key({ key: "?", code: "Minus", shiftKey: true }))).toBe("?");
    expect(shortcutFromEvent(key({ key: "+", code: "Equal", shiftKey: true }))).toBe("+");
  });

  it("ignores a bare modifier", () => {
    expect(shortcutFromEvent(key({ key: "Shift", shiftKey: true }))).toBeNull();
  });
});

function Harness({ actions = {}, onPlay, onUp }: { actions?: ShortcutActions; onPlay: () => void; onUp: () => void }) {
  useKeyboardShortcuts(actions);
  return (
    <div>
      <button type="button" aria-keyshortcuts="K Space" onClick={onPlay}>Play</button>
      <button type="button" aria-keyshortcuts="ArrowUp" onClick={onUp}>Up</button>
      <button type="button" aria-keyshortcuts="X" disabled onClick={onPlay}>Off</button>
      <div hidden><button type="button" aria-keyshortcuts="H" onClick={onPlay}>Hidden</button></div>
      <input aria-label="Search" aria-keyshortcuts="/" />
      <input aria-label="Name" />
    </div>
  );
}

describe("useKeyboardShortcuts", () => {
  it("clicks the control that declares the key", () => {
    const onPlay = vi.fn();
    const onUp = vi.fn();
    render(<Harness onPlay={onPlay} onUp={onUp} />);
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: " " });
    fireEvent.keyDown(document.body, { key: "+" });
    expect(onPlay).toHaveBeenCalledTimes(2);
    expect(onUp).toHaveBeenCalledTimes(1);
  });

  it("skips disabled and hidden controls", () => {
    const onPlay = vi.fn();
    render(<Harness onPlay={onPlay} onUp={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "x" });
    fireEvent.keyDown(document.body, { key: "h" });
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("stays out of the way while typing, and focuses a declared field", () => {
    const onPlay = vi.fn();
    render(<Harness onPlay={onPlay} onUp={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "k" });
    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "/" });
    expect(screen.getByLabelText("Search")).toHaveFocus();
  });

  it("runs an action first, and passes the key on when it declines", () => {
    const onPlay = vi.fn();
    const action = vi.fn(() => false);
    const { unmount } = render(<Harness actions={{ K: action }} onPlay={onPlay} onUp={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(action).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledTimes(1);
    unmount();
    const taken = vi.fn();
    render(<Harness actions={{ K: taken }} onPlay={onPlay} onUp={vi.fn()} />);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(taken).toHaveBeenCalledTimes(1);
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("acts once for a held key unless it repeats on purpose", () => {
    const onPlay = vi.fn();
    const onUp = vi.fn();
    render(<Harness onPlay={onPlay} onUp={onUp} />);
    fireEvent.keyDown(document.body, { key: "k" });
    fireEvent.keyDown(document.body, { key: "k", repeat: true });
    expect(onPlay).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "ArrowUp" });
    fireEvent.keyDown(document.body, { key: "ArrowUp", repeat: true });
    expect(onUp).toHaveBeenCalledTimes(2);
  });

  it("leaves keys alone while a modal dialog is open", () => {
    const onPlay = vi.fn();
    render(
      <>
        <Harness onPlay={onPlay} onUp={vi.fn()} />
        <div role="dialog" aria-modal="true">Confirm?</div>
      </>
    );
    fireEvent.keyDown(document.body, { key: "k" });
    expect(onPlay).not.toHaveBeenCalled();
  });
});
