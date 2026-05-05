# lttdl

a telegram bot for downloading media without watermarks. supports tiktok, youtube, instagram, pinterest, and music search. no ads, no sponsors.

## supported sources

| source | tool | notes |
|--------|------|-------|
| tiktok | [@tobyg74/tiktok-api-dl](https://github.com/tobyg74/tiktok-api-dl) | watermark-free video, multiple provider fallbacks (v1/v2/v3) |
| youtube | [yt-dlp](https://github.com/yt-dlp/yt-dlp) | video, audio-only, quality presets |
| instagram | [instaloader](https://github.com/instaloader/instaloader) | posts, reels |
| pinterest | [pinterest-dl](https://github.com/sean1832/pinterest-dl) (custom [fork](https://github.com/lavrentious/pinterest-dl)) | pins, boards |
| music search | [yt-dlp](https://github.com/yt-dlp/yt-dlp) | search youtube / youtube music, download as mp3 |

## tech

- [bun](https://bun.sh) — runtime
- [grammy](https://grammy.dev) — telegram bot framework
- sqlite (via `bun:sqlite`) — user settings, file share tracking
- ffmpeg — post-processing and format conversion

## requirements

- bun >= 1.3
- ffmpeg / ffprobe (required)
- yt-dlp (youtube, music search)
- instaloader (instagram)
- pinterest-dl (pinterest)

install system deps on debian/ubuntu:

```sh
apt install ffmpeg
pip install yt-dlp instaloader
pip install "git+https://github.com/lavrentious/pinterest-dl.git@main" # custom fork
# pip install pinterest-dl  # outdated for now
```

## installation

```sh
git clone https://github.com/lavrentious/lttdl
cd lttdl
bun install
cp example.env production.env
# edit production.env — at minimum set BOT_TOKEN
```

## running

```sh
# development (auto-restart on changes)
bun run dev

# production
bun run start
```

## deployment

### systemd

create `/etc/systemd/system/lttdl.service`:

```ini
[Unit]
Description=lttdl telegram bot
After=network.target

[Service]
Type=simple
User=lttdl
WorkingDirectory=/opt/lttdl
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/lttdl/production.env

[Install]
WantedBy=multi-user.target
```

```sh
systemctl enable --now lttdl
```

## configuration

all config is via environment variables. see `example.env` for the full reference with defaults.

**required:**
- `BOT_TOKEN` — from [@BotFather](https://t.me/BotFather)
- `NODE_ENV` — `production` or `development`

## features

### /settings

per-user configuration, accessible via the `/settings` command:

- **verbose output** — send source link details after every download
- **tiktok providers** — which extraction backends to try (v1 / v2 / v3, at least one required)
- **youtube preset** — quality and format preference for youtube downloads (`auto-video-audio`, `best`, `fast-1080`, `fast-720`, `auto-audio-only`, `best-audio`, `mid-audio`)
- **music search provider** — `youtube music` (songs section) or `youtube` (video results)
- **music search cookies** — use yt-dlp cookies when searching music (helps with restricted results, slower)

### music search

send a plain text query or `/music <query>` to search for a track and download it as mp3. results are paginated with inline buttons.

### cookies

for age-restricted or geo-restricted youtube content, set `YT_DLP_COOKIES_PATH` to a netscape-format cookies file (export from your browser with a "cookies.txt" extension).

> see [yt-dlp faq](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)

### file sharing

when enabled, the bot copies each downloaded file to a persistent directory and sends the user a direct http download link in addition to the telegram upload. files are automatically deleted after `FILE_SHARE_TTL_S` seconds (default 3600). per-user file sharing behavior can be configured via `/settings` (always / as fallback / never).

set `FILE_SHARE_ENABLED=true` and choose a server mode:

**proxy mode** (`FILE_SHARE_SERVER_MODE=proxy`, default):  
you serve `FILE_SHARE_DIR` with your own web server. see `docs/nginx-file-share.conf` for a sample nginx config.

```env
FILE_SHARE_ENABLED=true
FILE_SHARE_SERVER_MODE=proxy
FILE_SHARE_BASE_URL=https://example.com/files
FILE_SHARE_DIR=./shared
```

nginx location block (static):
```nginx
location /files/ {
    alias /opt/lttdl/shared/;
    add_header Content-Disposition "attachment";
    expires 1h;
}
```

**builtin mode** (`FILE_SHARE_SERVER_MODE=builtin`):  
the bot runs its own http server on `FILE_SHARE_SERVER_PORT`. useful for simple setups or local testing. can be put behind nginx as a reverse proxy.

```env
FILE_SHARE_ENABLED=true
FILE_SHARE_SERVER_MODE=builtin
FILE_SHARE_SERVER_PORT=3000
FILE_SHARE_BASE_URL=https://example.com/files
```

nginx reverse proxy (for builtin mode):
```nginx
location /files/ {
    proxy_pass http://127.0.0.1:3000/;
}
```

**optional knobs:**

| variable | default | description |
|----------|---------|-------------|
| `FILE_SHARE_TTL_S` | `3600` | how long shared files are kept before deletion |
| `FILE_SHARE_CLEANUP_INTERVAL_S` | `300` | how often expired files are purged (seconds) |
| `FILE_SHARE_MAX_DIR_SIZE_MB` | `0` | total storage cap for `FILE_SHARE_DIR` in MB; `0` = no limit. new shares are skipped (with a warning) when the cap would be exceeded |

## usage

- send a tiktok / youtube / instagram / pinterest link → bot downloads and sends the media
- send a text query → music search (or use `/music <query>`)
- `/settings` — configure per-user preferences
- `/start` — show help

downloads have a cancel button while in progress. rate limits apply per user (default: 10/min, 50/day).
