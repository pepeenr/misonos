import { useCallback, useEffect, useRef, useState } from "react";

// Which screen shows, kept in the browser history so the phone's back gesture, the
// browser's back button and a reload all do what they should. Playing is the base
// entry; Music and Library sit one step above it (switching between them replaces
// that step), and Settings and the group editor go one step above whatever opened them.

export type View = "main" | "browse" | "library" | "settings" | "editor";

/** The screens the tabs switch between; the others are pages you go back from. */
export const TAB_VIEWS: readonly View[] = ["main", "browse", "library"];

const HASHES: Record<View, string> = {
  main: "",
  browse: "#music",
  library: "#library",
  settings: "#settings",
  editor: "#groups"
};

interface ViewState {
  misonosView: View;
  /** How many app entries sit above the Playing one. */
  depth: number;
}

export function isTabView(view: View): boolean {
  return TAB_VIEWS.includes(view);
}

/** The screen a URL hash names, or null for none (an empty or unknown hash). */
export function viewFromHash(hash: string): View | null {
  const entry = Object.entries(HASHES).find(([, value]) => value !== "" && value === hash);
  return entry ? (entry[0] as View) : null;
}

function readState(): ViewState | null {
  const state = window.history.state as Partial<ViewState> | null;
  if (!state || typeof state.misonosView !== "string" || !(state.misonosView in HASHES)) return null;
  return { misonosView: state.misonosView, depth: typeof state.depth === "number" ? state.depth : 0 };
}

function urlFor(view: View): string {
  const { pathname, search, hash } = window.location;
  // Playing keeps a hash the app doesn't own; the screens replace it with theirs.
  const keep = view === "main" && !viewFromHash(hash) ? hash : "";
  return `${pathname}${search}${HASHES[view] || keep}`;
}

function write(kind: "push" | "replace", view: View, depth: number) {
  const state: ViewState = { misonosView: view, depth };
  if (kind === "push") window.history.pushState(state, "", urlFor(view));
  else window.history.replaceState(state, "", urlFor(view));
}

function initialView(): View {
  return readState()?.misonosView ?? viewFromHash(window.location.hash) ?? "main";
}

export function useViewHistory() {
  const [view, setViewState] = useState<View>(initialView);
  // navigate() reads the screen it leaves from here, so two quick calls see each other.
  const viewRef = useRef(view);
  const setView = useCallback((next: View) => {
    viewRef.current = next;
    setViewState(next);
  }, []);

  useEffect(() => {
    // A reload keeps the entries and their state: nothing to set up.
    if (!readState()) {
      const opened = viewFromHash(window.location.hash);
      if (opened && opened !== "main") {
        // Opened straight on a screen (a bookmark): put Playing under it, so back lands there.
        write("replace", "main", 0);
        write("push", opened, 1);
      } else {
        write("replace", "main", 0);
      }
    }
    const onPopState = () => {
      setView(readState()?.misonosView ?? viewFromHash(window.location.hash) ?? "main");
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [setView]);

  const navigate = useCallback((next: View) => {
    const current = viewRef.current;
    if (next === current) return;
    const depth = readState()?.depth ?? 0;
    if (next === "main") {
      // Back down to the Playing entry; popstate shows it.
      if (depth > 0) window.history.go(-depth);
      else {
        write("replace", "main", 0);
        setView("main");
      }
      return;
    }
    if (isTabView(next) && isTabView(current) && current !== "main") write("replace", next, depth);
    else write("push", next, depth + 1);
    setView(next);
  }, [setView]);

  const goBack = useCallback(() => {
    if ((readState()?.depth ?? 0) > 0) window.history.back();
    else navigate("main");
  }, [navigate]);

  return { view, navigate, goBack };
}
