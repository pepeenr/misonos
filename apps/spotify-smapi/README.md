# @misonos/spotify-smapi

A MiSonos source server for your **Spotify** library. Browse and search come from
the Spotify Web API. Playback doesn't: Spotify audio can't be proxied, so the bridge
hands each item to Sonos as a Spotify URI and the speakers play it with the Spotify
account linked in the Sonos app, like the Sonos app itself does.

## Setup

1. Create an app on the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
   and tick **Web API**. In Development mode the app's owner needs Spotify Premium,
   and at most five authorized users can sign in. MiSonos needs one sign-in: the
   owner's.
2. Add the Redirect URI the Settings card shows:
   `<the address you open MiSonos on>/api/sources/spotify/auth/callback`. Spotify takes
   https, or plain http only for `127.0.0.1`/`[::1]`, so a LAN address like
   `http://192.168.1.10:6173` won't do. Open MiSonos over https (a Tailscale or
   Cloudflare hostname) to connect. Set `MISONOS_SPOTIFY_REDIRECT_URI` to pin one.
3. Set `MISONOS_SPOTIFY_CLIENT_ID` to the app's Client ID and restart the service.
   Sign-in uses the PKCE flow, so there is no client secret.
4. In MiSonos, open **Settings → Spotify → Connect Spotify**. The refresh token is
   stored by this service, so one sign-in serves every device using this MiSonos.

### Which Sonos account plays

Sonos addresses a linked Spotify account by its serial number (`sn`) and a token,
and current firmware no longer lists either in `/status/accounts`. The bridge reads
them off Spotify items the speakers already hold: Sonos Favorites and the queues.
With no Spotify item there, add any Spotify song to your Sonos Favorites in the Sonos
app. When several Spotify accounts are linked, pick the one you connected under
Settings → Spotify → Sonos account (the default is the one most favorites use), or
pin it with `MISONOS_SPOTIFY_SN` on the bridge.

## Endpoints (JSON, consumed by the bridge)

- `GET /info`: descriptor (`capabilities: ["search", "sonos-only"]`). **503** until
  `MISONOS_SPOTIFY_CLIENT_ID` is set, which keeps the source out of the picker.
- `GET /browse?id=`: root (Playlists, Liked Songs, Albums, Artists, Recently Played,
  Top Tracks) or a node. Signed out, the root is a single notice.
- `GET /search?q=`: songs, artists, albums and playlists under section headers.
- `GET /track?id=`: metadata for a playable id. Playable ids are Spotify URIs
  (`spotify:track:…`, and `spotify:album:…` / `spotify:playlist:…` for whole
  containers); the returned `url` is the URI itself.
- `GET /auth/status`, `GET /auth/login?redirect_uri=`, `GET /auth/callback`,
  `POST /auth/logout`: the PKCE sign-in, driven by the bridge's
  `/api/sources/spotify/auth/*` routes.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MISONOS_SPOTIFY_CLIENT_ID` | — | required; your Spotify app's Client ID |
| `MISONOS_SPOTIFY_REDIRECT_URI` | from the browser | pin the OAuth redirect URI |
| `MISONOS_SPOTIFY_TOKEN_PATH` | `~/.misonos/spotify-token.json` | refresh token store; `/data/spotify-token.json` under Docker |
| `MISONOS_SPOTIFY_PORT` | `4326` | HTTP port |
| `MISONOS_SPOTIFY_NAME` | `Spotify` | name shown in the source picker |

On the bridge: `MISONOS_SPOTIFY_URL` (default `http://127.0.0.1:4326`) and, optionally,
`MISONOS_SPOTIFY_SN` / `MISONOS_SPOTIFY_SID` / `MISONOS_SPOTIFY_ACCOUNT_TOKEN` to pin
the Sonos account.

## Notes & limitations

- **Album and playlist rows play whole.** Play on one queues a single container URI
  and Sonos expands it, so a 2,000-song playlist is one call. Drilling in lists the
  tracks (up to 300).
- **Playlists you don't own** don't list their tracks: since February 2026 the Web API
  returns a playlist's items only to its owner and collaborators. Such a playlist
  shows a single "Whole playlist" item that Sonos plays.
- Search returns at most 10 results per type (the API's limit since February 2026).
- Artists list their albums, singles and compilations; the API no longer has artist
  top tracks.
- Spotify plays on Sonos speakers only, not on "This device", and the VU meter shows no
  signal for it.
- Spotify refresh tokens expire after six months; reconnect in Settings when the card
  says you're signed out.
- A favorite or recently played Spotify track still plays when the source is signed out,
  since Sonos only needs the URI.
