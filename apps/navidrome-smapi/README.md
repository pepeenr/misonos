# @misonos/navidrome-smapi

A MiSonos source server for your own music library on **Navidrome** — or any
server that speaks the Subsonic API (Gonic, Airsonic, …). Browse and search come
from the Subsonic JSON API; the bridge stream-proxies each track to Sonos like
every other source, so nothing has to be registered on the speakers.

Sonos can't decode **Opus** (or Opus-in-Ogg). Those files are transcoded by the
server on the fly — to MP3 at 320 kbps by default — while MP3, FLAC, AAC/ALAC,
WAV and AIFF stream untouched.

## Endpoints (JSON, consumed by the bridge)

- `GET /info` — descriptor (`capabilities: ["search"]`); **503** until configured,
  which keeps the source out of the picker.
- `GET /browse?id=` — root (Artists, Albums, Playlists, Genres, Starred) or a node.
  Albums offers Recently Added, Recently Played, Most Played, Random and A–Z.
- `GET /search?q=` — artists, albums and songs under section headers.
- `GET /track?id=` — a song's metadata plus this service's `/stream` URL.
- `GET /stream?id=` — the audio, proxied from the server with auth added.
- `GET /art?id=&size=` — cover art, proxied the same way.
- `GET /config` — the active login (`source`: `saved`, `env` or `none`, plus server
  URL and username; never the password or token).
- `POST /config` `{ serverUrl, username, password }` — tests the login with
  `ping` and, if the server accepts it, saves it and switches over at once.
- `POST /config/clear` — forgets the saved login and falls back to the env vars.

The Subsonic token never leaves this process: track and art URLs point back here,
not at Navidrome.

## Login

Log in from MiSonos under **Settings → Custom Music Services** (the bridge relays
`/api/sources/navidrome/config` here), or set the env vars below. A saved login
wins over the env vars. It is stored as a fixed Subsonic salt + token
(`md5(password + salt)`), not as the password: the token still opens the Subsonic
API, but not the Navidrome web UI, and doesn't reveal a reused password.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `MISONOS_NAVIDROME_SERVER_URL` | — | e.g. `http://127.0.0.1:4533`; fallback when nothing is saved |
| `MISONOS_NAVIDROME_USER` / `MISONOS_NAVIDROME_PASSWORD` | — | fallback login; a dedicated non-admin user is enough |
| `MISONOS_NAVIDROME_LOGIN_PATH` | `~/.misonos/navidrome-login.json` | where a login saved from Settings is kept |
| `MISONOS_NAVIDROME_PUBLIC_URL` | Host header | base URL the **speakers** use for cover art — set to `http://<lan-ip>:4325` under Docker |
| `MISONOS_NAVIDROME_PORT` | `4325` | HTTP port |
| `MISONOS_NAVIDROME_TRANSCODE_FORMAT` | `mp3` | target for non-native files; must be a transcoding your server has |
| `MISONOS_NAVIDROME_MAX_BITRATE` | `320` | kbps for transcoded files |
| `MISONOS_NAVIDROME_NAME` | `Navidrome` | name shown in the source picker |

## Notes & limitations

- **Transcoded tracks are sized up front.** Sonos wants a Content-Length and seeks
  with byte ranges, which a transcode can't give until it's done. For constant-bitrate
  MP3, bytes map linearly to time: the response claims the song's duration (plus a
  second) at the transcode's bitrate — predicted from the song, then read off its
  first frame — and is cut or zero-padded to exactly that. A Range becomes a
  `timeOffset`. HEAD requests are answered without starting a transcode. With
  another `TRANSCODE_FORMAT`, transcoded tracks stream unsized and can't be seeked.
- Proxies in front of the server (e.g. a Cloudflare tunnel) can drop Content-Length
  from full responses; for files streamed raw it's restored from the file size.
- Browse lists aren't paged (the bridge has no paging): A–Z loads the whole album
  list, and Artists, Genres, Playlists and A–Z are cached for five minutes.
- Starring, ratings and scrobbling aren't wired up yet.
