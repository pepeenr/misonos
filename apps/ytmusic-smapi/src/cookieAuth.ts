import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

// YouTube Music's library/personalized surfaces require an authenticated WEB_REMIX
// identity. OAuth (auth.ts) is unreliable for those browse calls, so we let the user
// paste a "Copy as cURL" (or raw request headers) captured from music.youtube.com and
// replay its cookies + a computed SAPISIDHASH Authorization header on browse requests.
// See DEPLOY / settings UI for the capture steps.

const ORIGIN = "https://music.youtube.com";
const COOKIES_PATH = process.env.YTMUSIC_COOKIES_PATH ?? `${homedir()}/.misonos/ytmusic-cookies.json`;

interface CookieCreds {
  cookie: string;
  authUser: string;
}

let creds: CookieCreds | null = null;

export type CookieAuthStatus = { cookieAuth: "signed-in" | "signed-out" };

export function cookieAuthStatus(): CookieAuthStatus {
  return { cookieAuth: creds ? "signed-in" : "signed-out" };
}

export function hasCookieAuth(): boolean {
  return creds !== null;
}

// Raw cookie string, for building an authenticated youtubei.js client (podcast
// episodes only stream for a signed-in session).
export function getCookieString(): string | null {
  return creds?.cookie ?? null;
}

// Build the auth headers for an authenticated YTM request, or {} when not signed in.
export function cookieAuthHeaders(): Record<string, string> {
  if (!creds) return {};
  const map = parseCookieMap(creds.cookie);
  const sapisid = map.SAPISID ?? map["__Secure-3PAPISID"] ?? map["__Secure-1PAPISID"];
  if (!sapisid) return {};
  return {
    Cookie: creds.cookie,
    Authorization: `SAPISIDHASH ${sapisidHash(sapisid)}`,
    "X-Goog-AuthUser": creds.authUser
  };
}

function sapisidHash(sapisid: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const digest = createHash("sha1").update(`${ts} ${sapisid} ${ORIGIN}`).digest("hex");
  return `${ts}_${digest}`;
}

function parseCookieMap(cookie: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    map[part.slice(0, eq).trim()] = part.slice(eq + 1);
  }
  return map;
}

// Chrome on Windows offers "Copy as cURL (cmd)" first. It wraps every value in ^"…^",
// puts ^ before special characters (%3D becomes ^%^3D) and ends each line with ^.
// Undo that, so a cmd paste reads like the bash one.
function unescapeCmd(raw: string): string {
  if (!raw.includes('^"')) return raw;
  return raw.replace(/\^\r?\n/g, " ").replace(/\^([\s\S])/g, "$1");
}

// A cookie header's value: `name=value; name=value`, at least two of them.
const COOKIE_LIST = /^[^\s=;'"]+=[^;]*(?:;\s*[^\s=;'"]+=[^;]*)+;?$/;

// Pull the Cookie value out of what was pasted: "Copy as cURL" (bash or cmd), "Copy as
// PowerShell", a request-header block, or just the cookie header's value.
export function extractCookie(raw: string): string | undefined {
  const text = unescapeCmd(raw);
  const forms = [
    /(?:-H|--header)\s+\$?'cookie:\s*([^']*)'/i,
    /(?:-H|--header)\s+"cookie:\s*([^"]*)"/i,
    /(?:-b|--cookie)\s+\$?'([^']*)'/i,
    /(?:-b|--cookie)\s+"([^"]*)"/i,
    /^\s*cookie:\s*(.+)$/im
  ];
  for (const re of forms) {
    const match = text.match(re);
    if (match && match[1].trim()) return match[1].trim();
  }
  // Copy as PowerShell: $session.Cookies.Add((New-Object System.Net.Cookie("SID", "…", "/", ".youtube.com")))
  const powershell = [...text.matchAll(/New-Object\s+System\.Net\.Cookie\(\s*"([^"]+)"\s*,\s*"([^"]*)"/gi)];
  if (powershell.length > 0) return powershell.map(([, name, value]) => `${name}=${value}`).join("; ");
  // Just the header's value, on a line of its own.
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^['"]|['"]$/g, "");
    if (COOKIE_LIST.test(candidate)) return candidate;
  }
  return undefined;
}

export function extractAuthUser(raw: string): string {
  const text = unescapeCmd(raw);
  const match = text.match(/(?:-H|--header)\s+\$?['"]x-goog-authuser:\s*([^'"]*)['"]/i)
    ?? text.match(/^\s*x-goog-authuser:\s*(.+)$/im)
    ?? text.match(/"x-goog-authuser"\s*=\s*"([^"]*)"/i);
  return match ? match[1].trim() : "0";
}

const SIGN_IN_COOKIES = "SID and SAPISID";

// Why a paste gave no cookies, as a next step for the person pasting it.
function noCookieMessage(raw: string): string {
  if (/\bfetch\(/.test(raw)) {
    return "That's “Copy as fetch”, which leaves out the cookies. Right-click the request again and pick “Copy as cURL” (cmd or bash).";
  }
  if (!/music\.youtube\.com/i.test(raw)) {
    return "No cookies in that, and it isn't a music.youtube.com request. In DevTools → Network on music.youtube.com, type “browse” in the filter, right-click a request → Copy → Copy as cURL, and paste all of it.";
  }
  return "That music.youtube.com request has no cookies in it. Make sure you're signed in there, reload the page, and copy a “browse” request with Copy → Copy as cURL.";
}

// Validate + persist credentials from a pasted cURL/header blob. Throws a message that
// says what's missing and what to copy instead.
export async function setCookiesFromPaste(raw: string): Promise<CookieAuthStatus> {
  const cookie = extractCookie(raw);
  if (!cookie) throw new Error(noCookieMessage(raw));
  const map = parseCookieMap(cookie);
  const hasApiSid = !!(map.SAPISID || map["__Secure-3PAPISID"] || map["__Secure-1PAPISID"]);
  const hasSession = !!(map.SID || map["__Secure-3PSID"] || map["__Secure-1PSID"]);
  if (!hasApiSid || !hasSession) {
    const count = Object.keys(map).length;
    throw new Error(
      `Found ${count} cookie${count === 1 ? "" : "s"}, but not YouTube's sign-in ones (${SIGN_IN_COOKIES}). ` +
      "Sign in at music.youtube.com first, and copy a request to music.youtube.com itself, not to another site."
    );
  }
  creds = { cookie, authUser: extractAuthUser(raw) };
  await persist(creds);
  return cookieAuthStatus();
}

export async function clearCookies(): Promise<CookieAuthStatus> {
  creds = null;
  await rm(COOKIES_PATH, { force: true }).catch(() => undefined);
  return cookieAuthStatus();
}

// Drop credentials when YouTube rejects them (401/403) so the UI stops reporting
// "connected" and serving authed requests with dead cookies. The user re-pastes.
export function invalidateCookieAuth(): void {
  if (!creds) return;
  creds = null;
  void rm(COOKIES_PATH, { force: true }).catch(() => undefined);
  console.warn("[ytmusic] cookie auth rejected (401/403) — cleared; re-paste cookies to reconnect");
}

export async function restoreCookies(): Promise<void> {
  try {
    const data = await readFile(COOKIES_PATH, "utf8");
    const parsed = JSON.parse(data) as CookieCreds;
    if (parsed.cookie) {
      creds = { cookie: parsed.cookie, authUser: parsed.authUser ?? "0" };
      console.log("[ytmusic] restored saved cookie credentials");
    }
  } catch {
    /* no saved cookies — fine */
  }
}

async function persist(value: CookieCreds): Promise<void> {
  await mkdir(dirname(COOKIES_PATH), { recursive: true });
  await writeFile(COOKIES_PATH, JSON.stringify(value, null, 2), "utf8");
}
