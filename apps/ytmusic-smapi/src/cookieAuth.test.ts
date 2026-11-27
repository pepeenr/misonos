import { describe, expect, it } from "vitest";
import { extractAuthUser, extractCookie, setCookiesFromPaste } from "./cookieAuth.js";

const COOKIE = "YSC=abc; VISITOR_PRIVACY_METADATA=CgJERRIEGgAgKg%3D%3D; SID=g.a000xyz; __Secure-3PSID=g.a000q; SAPISID=AbC/dEf; __Secure-3PAPISID=AbC/dEf";

describe("pasted YouTube Music cookies", () => {
  it("reads Copy as cURL (bash), with -b or a cookie header", () => {
    const withB = `curl 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false' \\\n  -H 'accept: */*' \\\n  -b '${COOKIE}' \\\n  -H 'x-goog-authuser: 1' \\\n  --data-raw '{"context":{}}'`;
    expect(extractCookie(withB)).toBe(COOKIE);
    expect(extractAuthUser(withB)).toBe("1");
    expect(extractCookie(`curl 'https://music.youtube.com/' -H $'cookie: ${COOKIE}'`)).toBe(COOKIE);
  });

  it("reads Copy as cURL (cmd), Chrome's first choice on Windows", () => {
    const caret = (value: string) => value.replace(/%/g, "^%^");
    const cmd = [
      'curl ^"https://music.youtube.com/youtubei/v1/browse?prettyPrint=false^" ^',
      '  -H ^"accept: */*^" ^',
      `  -b ^"${caret(COOKIE)}^" ^`,
      '  -H ^"x-goog-authuser: 2^" ^',
      '  --data-raw ^"^{^\\^"context^\\^":^{^}^}^"'
    ].join("\r\n");
    expect(extractCookie(cmd)).toBe(COOKIE);
    expect(extractAuthUser(cmd)).toBe("2");
  });

  it("reads Copy as PowerShell", () => {
    const powershell = [
      "$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession",
      '$session.Cookies.Add((New-Object System.Net.Cookie("SID", "g.a000xyz", "/", ".youtube.com")))',
      '$session.Cookies.Add((New-Object System.Net.Cookie("SAPISID", "AbC/dEf", "/", ".youtube.com")))',
      'Invoke-WebRequest -UseBasicParsing -Uri "https://music.youtube.com/youtubei/v1/browse" -WebSession $session -Headers @{',
      '"x-goog-authuser"="3"',
      "}"
    ].join("\n");
    expect(extractCookie(powershell)).toBe("SID=g.a000xyz; SAPISID=AbC/dEf");
    expect(extractAuthUser(powershell)).toBe("3");
  });

  it("reads a request-header block, or the cookie header's value alone", () => {
    expect(extractCookie(`:authority: music.youtube.com\ncookie: ${COOKIE}\nx-goog-authuser: 0`)).toBe(COOKIE);
    expect(extractCookie(`  ${COOKIE}  `)).toBe(COOKIE);
  });

  it("says what to copy instead when there are no cookies", async () => {
    await expect(setCookiesFromPaste('fetch("https://music.youtube.com/youtubei/v1/browse", { "credentials": "include" })'))
      .rejects.toThrow(/Copy as fetch.*leaves out the cookies/);
    await expect(setCookiesFromPaste("curl 'https://music.youtube.com/youtubei/v1/browse' -H 'accept: */*'"))
      .rejects.toThrow(/has no cookies in it.*signed in/);
    await expect(setCookiesFromPaste("hello")).rejects.toThrow(/isn't a music\.youtube\.com request/);
  });

  it("says when the cookies aren't signed in", async () => {
    await expect(setCookiesFromPaste("curl 'https://music.youtube.com/' -b 'YSC=abc; VISITOR_INFO1_LIVE=def'"))
      .rejects.toThrow(/Found 2 cookies, but not YouTube's sign-in ones \(SID and SAPISID\)/);
  });
});
