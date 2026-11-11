import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewHistory, viewFromHash } from "./viewHistory.js";

// jsdom shares one history across tests: start each on a fresh entry with no app state.
function openAt(url: string) {
  window.history.replaceState(null, "", url);
}

afterEach(() => openAt("/"));

describe("viewFromHash", () => {
  it("names the screens and ignores other hashes", () => {
    expect(viewFromHash("#music")).toBe("browse");
    expect(viewFromHash("#library")).toBe("library");
    expect(viewFromHash("#settings")).toBe("settings");
    expect(viewFromHash("#groups")).toBe("editor");
    expect(viewFromHash("")).toBeNull();
    expect(viewFromHash("#queue")).toBeNull();
  });
});

describe("useViewHistory", () => {
  it("puts Music above Playing, so back returns to Playing", async () => {
    openAt("/");
    const { result } = renderHook(() => useViewHistory());
    expect(result.current.view).toBe("main");

    act(() => result.current.navigate("browse"));
    expect(result.current.view).toBe("browse");
    expect(window.location.hash).toBe("#music");

    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.view).toBe("main"));
    expect(window.location.hash).toBe("");
  });

  it("swaps Music for Library in place: one back still reaches Playing", async () => {
    openAt("/");
    const { result } = renderHook(() => useViewHistory());

    act(() => result.current.navigate("browse"));
    act(() => result.current.navigate("library"));
    expect(window.location.hash).toBe("#library");

    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.view).toBe("main"));
    expect(window.location.hash).toBe("");
  });

  it("goes down to Playing from two screens up in one step", async () => {
    openAt("/");
    const { result } = renderHook(() => useViewHistory());

    act(() => result.current.navigate("browse"));
    act(() => result.current.navigate("settings"));
    act(() => result.current.navigate("main"));
    await waitFor(() => expect(result.current.view).toBe("main"));
    expect(window.location.hash).toBe("");
  });

  it("returns from Settings to the tab that opened it", async () => {
    openAt("/");
    const { result } = renderHook(() => useViewHistory());

    act(() => result.current.navigate("library"));
    act(() => result.current.navigate("settings"));
    expect(window.location.hash).toBe("#settings");

    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.view).toBe("library"));
    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.view).toBe("main"));
  });

  it("opens straight on a screen from its link, with Playing beneath it", async () => {
    openAt("/#settings");
    const { result } = renderHook(() => useViewHistory());
    expect(result.current.view).toBe("settings");

    act(() => result.current.goBack());
    await waitFor(() => expect(result.current.view).toBe("main"));
    expect(window.location.hash).toBe("");
  });

  it("leaves a hash it doesn't own alone on Playing", () => {
    openAt("/#queue");
    const { result } = renderHook(() => useViewHistory());
    expect(result.current.view).toBe("main");
    expect(window.location.hash).toBe("#queue");
  });
});
