import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const REQUEST_TIMEOUT_MS = 10000;
// A started sign-in must come back within this long.
const LOGIN_TTL_MS = 10 * 60 * 1000;
// Refresh this long before the access token runs out.
const EXPIRY_MARGIN_MS = 60 * 1000;

// Read-only access to what the browse tree shows.
export const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
  "user-follow-read",
  "user-read-recently-played",
  "user-top-read"
];

export interface SpotifyUser {
  id: string;
  displayName?: string;
}

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope?: string;
  user?: SpotifyUser;
}

export interface AuthStatus {
  signedIn: boolean;
  user?: SpotifyUser;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export class SpotifyAuthError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "SpotifyAuthError";
  }
}

// Authorization code flow with PKCE. The tokens never leave this process: the browser
// only carries the one-time code back through the bridge.
export class SpotifyAuth {
  private pending = new Map<string, { verifier: string; redirectUri: string; expires: number }>();
  // undefined until the token file has been read; null when signed out.
  private token: StoredToken | null | undefined;
  private refreshing: Promise<string> | undefined;

  constructor(
    private readonly clientId: string,
    private readonly tokenPath: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  // The Spotify URL to send the browser to.
  beginLogin(redirectUri: string): string {
    this.prune();
    const state = base64url(randomBytes(16));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    this.pending.set(state, { verifier, redirectUri, expires: Date.now() + LOGIN_TTL_MS });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.clientId,
      scope: SCOPES.join(" "),
      redirect_uri: redirectUri,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge
    }).toString();
    return url.toString();
  }

  async completeLogin(code: string, state: string): Promise<void> {
    this.prune();
    const login = this.pending.get(state);
    if (!login) throw new SpotifyAuthError("This sign-in expired or was already used. Start it again from Settings.", 400);
    this.pending.delete(state);
    const response = await this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: login.redirectUri,
      client_id: this.clientId,
      code_verifier: login.verifier
    });
    if (!response.refresh_token) throw new SpotifyAuthError("Spotify didn't return a refresh token", 502);
    await this.save(fromResponse(response, response.refresh_token));
  }

  async accessToken(): Promise<string> {
    const token = await this.load();
    if (!token) throw new SpotifyAuthError("Not signed in to Spotify", 401);
    if (token.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return token.accessToken;
    return this.refresh();
  }

  // Also used after a 401 on a token that still looked valid.
  refresh(): Promise<string> {
    this.refreshing ??= this.refreshNow().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async status(): Promise<AuthStatus> {
    const token = await this.load();
    return token ? { signedIn: true, user: token.user } : { signedIn: false };
  }

  async setUser(user: SpotifyUser): Promise<void> {
    const token = await this.load();
    if (token) await this.save({ ...token, user });
  }

  async signOut(): Promise<void> {
    this.token = null;
    await rm(this.tokenPath, { force: true });
  }

  private async refreshNow(): Promise<string> {
    const current = await this.load();
    if (!current) throw new SpotifyAuthError("Not signed in to Spotify", 401);
    try {
      const response = await this.requestToken({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: this.clientId
      });
      // Spotify may rotate the refresh token; keep the old one when it doesn't.
      const next = { ...fromResponse(response, response.refresh_token ?? current.refreshToken), user: current.user };
      await this.save(next);
      return next.accessToken;
    } catch (error) {
      // A revoked or expired refresh token (they last six months) means signing in again.
      if (error instanceof SpotifyAuthError && error.code === "invalid_grant") {
        await this.signOut();
        throw new SpotifyAuthError("The Spotify sign-in expired. Connect Spotify again in Settings.", 401, error.code);
      }
      throw error;
    }
  }

  private async requestToken(form: Record<string, string>): Promise<TokenResponse> {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error?: string; error_description?: string };
    if (!response.ok || !body.access_token) {
      const message = body.error_description || body.error || `token request failed (${response.status})`;
      throw new SpotifyAuthError(`Spotify: ${message}`, response.status >= 500 ? 502 : 400, body.error);
    }
    return body as TokenResponse;
  }

  private async load(): Promise<StoredToken | null> {
    if (this.token !== undefined) return this.token;
    try {
      const parsed = JSON.parse(await readFile(this.tokenPath, "utf8")) as Partial<StoredToken>;
      this.token = parsed.accessToken && parsed.refreshToken
        ? { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken, expiresAt: Number(parsed.expiresAt) || 0, scope: parsed.scope, user: parsed.user }
        : null;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  private async save(token: StoredToken): Promise<void> {
    this.token = token;
    await mkdir(path.dirname(this.tokenPath), { recursive: true });
    const temp = `${this.tokenPath}.tmp`;
    await writeFile(temp, JSON.stringify(token, null, 2), { mode: 0o600 });
    await rename(temp, this.tokenPath);
  }

  private prune(): void {
    const now = Date.now();
    for (const [state, login] of this.pending) {
      if (login.expires <= now) this.pending.delete(state);
    }
  }
}

function fromResponse(response: TokenResponse, refreshToken: string): StoredToken {
  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000,
    scope: response.scope
  };
}

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}
