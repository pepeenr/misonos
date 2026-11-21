import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useViewHistory } from "../src/viewHistory.js";

describe("switching screens", () => {
  let scrollTo: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });
  afterEach(() => scrollTo.mockRestore());

  it("opens each screen at its top, not as far down as the last one was scrolled", () => {
    const { result } = renderHook(() => useViewHistory());
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => result.current.navigate("browse"));
    expect(result.current.view).toBe("browse");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "instant" });

    act(() => result.current.navigate("library"));
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("does it on the back gesture too", () => {
    const { result } = renderHook(() => useViewHistory());
    act(() => result.current.navigate("settings"));
    scrollTo.mockClear();

    act(() => {
      window.history.replaceState({ misonosView: "main", depth: 0 }, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current.view).toBe("main");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("leaves the scroll alone when the screen stays the same", () => {
    const { result } = renderHook(() => useViewHistory());
    act(() => result.current.navigate("main"));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
