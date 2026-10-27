import { useEffect, useRef } from "react";

// Keyboard shortcuts. A control declares its keys with aria-keyshortcuts ("K Space",
// "Shift+1"), and a key press clicks the first visible, enabled control that declares
// it: the shortcut does exactly what the button does, and only while it's on screen.
// Actions without a single button (seeking, switching rooms, closing overlays) go to
// useKeyboardShortcuts; returning false from one passes the key on to the controls.

export type ShortcutActions = Partial<Record<string, () => boolean | void>>;

type KeyInfo = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

/** The key press in aria-keyshortcuts form ("Shift+N", "ArrowUp", "?"), or null for a bare modifier. */
export function shortcutFromEvent(event: KeyInfo): string | null {
  const { key } = event;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" || key === "AltGraph") return null;
  // Shift+1 reports "!" (or "§", depending on the layout) as its key, so digits come from the physical key.
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  const name = digit ?? (key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key);
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Meta");
  // For a symbol, Shift is part of the character ("?" is Shift+/ on one layout and
  // Shift+ß on another), so it only counts for letters, digits and named keys.
  if (event.shiftKey && (/^[A-Z0-9]$/.test(name) || key.length > 1)) modifiers.push("Shift");
  return [...modifiers, name].join("+");
}

// Keys that mean the same as another: volume on +/− as well as the arrows.
const ALIASES: Record<string, string> = { "+": "ArrowUp", "=": "ArrowUp", "-": "ArrowDown" };

// Only these act again while held; at most about 8 times a second, so a held volume
// key doesn't flood the speakers with requests.
const REPEATABLE = /^(Shift\+)?(ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/;
const REPEAT_INTERVAL_MS = 120;

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "password", "number", "url", "tel", "date", "time", "datetime-local", "month", "week"]);

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

// Keys the focused element uses itself. Space activates a button or switch that was
// reached with the keyboard; after a mouse click it plays or pauses instead, so a
// clicked playlist tile doesn't start over on Space. Arrows move sliders, radios and menus.
function ownedByFocus(target: EventTarget | null, combo: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (combo === "Space" || combo === "Enter") {
    const control = target.closest("button, a[href], input, [role=button], [role=switch], [role=option], [role=menuitem]");
    return !!control && (combo === "Enter" || focusVisible(control) || control instanceof HTMLInputElement);
  }
  if (/^(Shift\+)?(Arrow|Home|End|Page)/.test(combo)) {
    return target.matches("input[type=range], input[type=radio], [role=slider]") || !!target.closest("[role=menu], [role=listbox], [role=radiogroup]");
  }
  return false;
}

function findControl(combo: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>("[aria-keyshortcuts]")) {
    if (!(element.getAttribute("aria-keyshortcuts") ?? "").split(/\s+/).includes(combo)) continue;
    if (element.matches(":disabled, [aria-disabled=true]") || element.closest("[hidden]")) continue;
    if (typeof element.checkVisibility === "function" && !element.checkVisibility()) continue;
    return element;
  }
  return null;
}

/** Runs `actions` and the aria-keyshortcuts controls from key presses anywhere in the page. */
export function useKeyboardShortcuts(actions: ShortcutActions): void {
  const actionsRef = useRef(actions);
  useEffect(() => { actionsRef.current = actions; });

  useEffect(() => {
    let lastRepeatAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const pressed = shortcutFromEvent(event);
      if (!pressed) return;
      const combo = ALIASES[pressed] ?? pressed;
      if (isTyping(event.target) || ownedByFocus(event.target, combo)) return;
      // An open modal (confirm, prompt, the shortcut list) handles its own keys.
      if (document.querySelector("[aria-modal=true]")) return;
      const action = actionsRef.current[combo];
      if (event.repeat) {
        if (!REPEATABLE.test(combo) || event.timeStamp - lastRepeatAt < REPEAT_INTERVAL_MS) {
          // Still swallow a held key we handle, so a held Space doesn't scroll the page.
          if (action || findControl(combo)) event.preventDefault();
          return;
        }
        lastRepeatAt = event.timeStamp;
      }
      if (action && action() !== false) {
        event.preventDefault();
        return;
      }
      const control = findControl(combo);
      if (!control) return;
      event.preventDefault();
      if (isTyping(control)) control.focus();
      else control.click();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export interface ShortcutEntry {
  keys: string[];
  label: string;
}

/** What the shortcut list shows; keep it in step with the aria-keyshortcuts in the app. */
export const SHORTCUT_GROUPS: { title: string; entries: ShortcutEntry[] }[] = [
  {
    title: "Playback",
    entries: [
      { keys: ["Space", "K"], label: "Play or pause" },
      { keys: ["N"], label: "Next track" },
      { keys: ["P"], label: "Previous track" },
      { keys: ["←", "→"], label: "Back or forward 10 s (with Shift: 30 s)" },
      { keys: ["R"], label: "Repeat: off, all, one" },
      { keys: ["S"], label: "Shuffle" },
      { keys: ["C"], label: "Crossfade" },
      { keys: ["T"], label: "Sleep timer" },
      { keys: ["F"], label: "Favorite the station" },
      { keys: ["Shift F"], label: "Save the station as a preset" }
    ]
  },
  {
    title: "Volume",
    entries: [
      { keys: ["↑", "+"], label: "Volume up" },
      { keys: ["↓", "−"], label: "Volume down" },
      { keys: ["M"], label: "Mute" }
    ]
  },
  {
    title: "Rooms",
    entries: [
      { keys: ["G"], label: "Next room" },
      { keys: ["Shift G"], label: "Previous room" },
      { keys: ["Shift K"], label: "Pause every room" },
      { keys: ["E"], label: "Edit groups" }
    ]
  },
  {
    title: "Queue and playlists",
    entries: [
      { keys: ["Q"], label: "Show or hide the queue" },
      { keys: ["Shift Q"], label: "Save the queue as a playlist" },
      { keys: ["Shift Delete"], label: "Clear the queue" },
      { keys: ["Shift L"], label: "Show or hide playlists" },
      { keys: ["1 – 9"], label: "Play playlist 1 to 9" },
      { keys: ["Shift 1 – 9"], label: "Tune in preset 1 to 9" }
    ]
  },
  {
    title: "Screens",
    entries: [
      { keys: ["A"], label: "Full-screen album art" },
      { keys: ["V"], label: "VU meter" },
      { keys: ["B"], label: "Music sources" },
      { keys: ["L"], label: "Library" },
      { keys: [","], label: "Settings" },
      { keys: ["/"], label: "Search, in Music" },
      { keys: ["Esc"], label: "Close, or go back" },
      { keys: ["?"], label: "This list" }
    ]
  }
];
