import { useSyncExternalStore } from "react";
import { apiBase } from "./servers.js";

// A public MiSonos host can sit behind Cloudflare Access. When the Access session
// expires, the service worker still serves the cached app shell, but Access answers
// every /api call with a redirect to its login on another origin, so the calls fail
// like a network error and nothing ever shows the login. An installed app has no
// address bar to open a page that reaches Access by hand. So when a bridge call fails,
// ask Access directly whether the session is gone, and if it is, send the window
// through the login: the service worker leaves `/?signin` and Access's `/cdn-cgi/`
// callback to the network (vite.config.ts), and the login returns to `/?signin`, which
// loads the app again.

const SIGN_IN_PATH = "/?signin";
const ATTEMPT_KEY = "misonos:accessSignInAt";
// Go to the login unasked at most this often. A session that is still gone within this
// window after a login (a cookie that didn't stick) shows the banner instead of looping.
const AUTO_SIGN_IN_INTERVAL_MS = 2 * 60_000;
// After a check finds the session fine, failures in this window don't check again.
const CHECK_INTERVAL_MS = 30_000;

let signedOut = false;
let checking = false;
let lastCheckAt = -Infinity;
const listeners = new Set<() => void>();

function setSignedOut(value: boolean): void {
  if (signedOut === value) return;
  signedOut = value;
  for (const listener of listeners) listener();
}

/** True when Access answers in place of the bridge: a redirect to its login, or its 401. */
export async function accessSessionExpired(): Promise<boolean> {
  // X-Requested-With makes Access answer 401 instead of redirecting; "manual" catches
  // the redirect anyway. The bridge itself never redirects or 401s /api/health.
  const response = await fetch("/api/health", {
    cache: "no-store",
    redirect: "manual",
    headers: { "X-Requested-With": "XMLHttpRequest" }
  });
  if (response.type === "opaqueredirect") return true;
  return response.status === 401 && /cloudflare-access/i.test(response.headers.get("WWW-Authenticate") ?? "");
}

/** Send this window through the Access login; it comes back to the app. */
export function startAccessSignIn(): void {
  try {
    window.sessionStorage.setItem(ATTEMPT_KEY, String(Date.now()));
  } catch {
    /* storage disabled: the banner fallback just won't kick in */
  }
  window.location.assign(SIGN_IN_PATH);
}

function signedInRecently(): boolean {
  try {
    const at = Number(window.sessionStorage.getItem(ATTEMPT_KEY));
    return at > 0 && Date.now() - at < AUTO_SIGN_IN_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** A same-origin bridge call failed at the network level: check whether Access is why. */
export function noteBridgeFailure(): void {
  // A switched-to backend is another host, and its failures aren't this origin's login.
  if (signedOut || checking || apiBase()) return;
  if (Date.now() - lastCheckAt < CHECK_INTERVAL_MS) return;
  lastCheckAt = Date.now();
  checking = true;
  void accessSessionExpired()
    .then((expired) => {
      if (!expired) return;
      if (signedInRecently()) setSignedOut(true);
      else startAccessSignIn();
    })
    .catch(() => {
      /* the network itself is down: nothing Access can fix */
    })
    .finally(() => { checking = false; });
}

/** Drop the `?signin` marker the login returned to, so a reload doesn't keep it. */
export function clearSignInMarker(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("signin")) return;
  url.searchParams.delete("signin");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True once the Access session is gone and going to the login unasked didn't fix it. */
export function useAccessSignedOut(): boolean {
  return useSyncExternalStore(subscribe, () => signedOut, () => false);
}
