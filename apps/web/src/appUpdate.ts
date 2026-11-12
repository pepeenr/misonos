import { useEffect, useState } from "react";

// After a deploy, an open MiSonos keeps running the version it loaded. The service
// worker only looks for a new one when a page is opened, and a phone's home-screen app
// can stay open for days. So look now and then, and whenever the app comes back to the
// front. The service worker takes over as soon as it's installed (registerType
// "autoUpdate"), and then the page offers a reload rather than reloading by itself,
// which could cut off something in progress: a half-filled form, "This device" playing.

export const UPDATE_CHECK_MS = 30 * 60_000;
// Coming back to the app looks again, at most this often.
export const UPDATE_CHECK_ON_RETURN_MS = 60_000;

export interface AppUpdate {
  /** A newer version has taken over: a reload shows it. */
  ready: boolean;
  reload: () => void;
  dismiss: () => void;
}

export function useAppUpdate(): AppUpdate {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const worker = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!worker) return undefined;

    // The first install also takes over the page; only a worker replacing another one
    // is a new version. A worker counts once one ran this page or was already active.
    let replacing = Boolean(worker.controller);
    void worker.getRegistration()
      .then((registration) => { if (registration?.active) replacing = true; })
      .catch(() => undefined);
    const onControllerChange = () => {
      if (replacing) setReady(true);
      replacing = true;
    };
    worker.addEventListener("controllerchange", onControllerChange);

    let lastCheck = Date.now();
    const check = () => {
      lastCheck = Date.now();
      // Offline, or the server mid-restart: the next check tries again.
      void worker.getRegistration()
        .then((registration) => registration?.update())
        .catch(() => undefined);
    };
    const timer = window.setInterval(check, UPDATE_CHECK_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - lastCheck >= UPDATE_CHECK_ON_RETURN_MS) check();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      worker.removeEventListener("controllerchange", onControllerChange);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return {
    ready,
    reload: () => window.location.reload(),
    dismiss: () => setReady(false)
  };
}
