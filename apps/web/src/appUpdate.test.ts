import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UPDATE_CHECK_MS, UPDATE_CHECK_ON_RETURN_MS, useAppUpdate } from "./appUpdate.js";

// A stand-in for navigator.serviceWorker: jsdom has none.
function fakeWorkers({ controlled, active }: { controlled: boolean; active: boolean }) {
  const events = new EventTarget();
  const update = vi.fn(async () => undefined);
  const container = {
    controller: controlled ? {} : null,
    getRegistration: vi.fn(async () => (active || controlled ? { active: {}, update } : { active: null, update })),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  };
  Object.defineProperty(navigator, "serviceWorker", { value: container, configurable: true });
  return {
    update,
    takeOver: () => act(() => { container.controller = {}; events.dispatchEvent(new Event("controllerchange")); })
  };
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useAppUpdate", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "serviceWorker");
    Reflect.deleteProperty(document, "visibilityState");
  });

  it("offers a reload once a new version takes over the page", async () => {
    const workers = fakeWorkers({ controlled: true, active: true });
    const { result } = renderHook(() => useAppUpdate());
    await act(async () => undefined);
    expect(result.current.ready).toBe(false);

    workers.takeOver();
    expect(result.current.ready).toBe(true);

    act(() => result.current.dismiss());
    expect(result.current.ready).toBe(false);
  });

  it("doesn't count the very first install as an update", async () => {
    const workers = fakeWorkers({ controlled: false, active: false });
    const { result } = renderHook(() => useAppUpdate());
    await act(async () => undefined);

    workers.takeOver();
    expect(result.current.ready).toBe(false);
    // A later deploy is one.
    workers.takeOver();
    expect(result.current.ready).toBe(true);
  });

  it("counts a takeover after a hard reload, when a worker was already active", async () => {
    const workers = fakeWorkers({ controlled: false, active: true });
    const { result } = renderHook(() => useAppUpdate());
    await act(async () => undefined);

    workers.takeOver();
    expect(result.current.ready).toBe(true);
  });

  it("looks for a new version now and then, and on coming back to the app", async () => {
    const workers = fakeWorkers({ controlled: true, active: true });
    renderHook(() => useAppUpdate());

    // Back to the front right away: too soon to look again.
    setVisibility("visible");
    await act(async () => undefined);
    expect(workers.update).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_MS); });
    expect(workers.update).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(UPDATE_CHECK_ON_RETURN_MS); });
    setVisibility("hidden");
    await act(async () => undefined);
    expect(workers.update).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await act(async () => undefined);
    expect(workers.update).toHaveBeenCalledTimes(2);
  });

  it("does nothing where there are no service workers", () => {
    const { result } = renderHook(() => useAppUpdate());
    expect(result.current.ready).toBe(false);
  });
});
