# Cutline _(working name, pending)_

Cutline — local storyboard and ideation tool for planning YouTube videos.

Infinite canvas for beats, notes, clips, references, and audience cards; Notion idea-pipeline sync; local MKV / ProRes / DNxHR proxying for browser playback; timeline pacing; work-hours budget (optional ActivityWatch); Markdown / JSON export.

> Working name **Cutline** (rename in `public/js/brand.js`). Framed-sheet UI; tokens in `public/css/tokens.css` (dark-mode ready, light-only in v1).

## Screenshots

Non-personal demo board (local seed data only — not shipped as product defaults).

![Canvas — beats, audience, clips, timeline](docs/screenshots/canvas.png)

*Canvas — board canvas with clips, audience card, beat graph, timeline and hours meter.*

![Pace & parts — curve and table](docs/screenshots/pace-parts.png)

*Pace & parts — cumulative pace curve, hours against cap, and per-beat plan vs target.*

![Notion mapping — confirm-only](docs/screenshots/notion-mapping.png)

*Notion — pre-filled field mapping and side-by-side conflict (Keep local / Keep Notion / Edit).*

![First-run empty state](docs/screenshots/first-run.png)

*First-run — empty boards with setup steps and muted hours meter.*


## Requirements (Arch)

- Node.js 20+
- npm
- ffmpeg (provides `ffmpeg` and `ffprobe`)

```bash
sudo pacman -S --needed nodejs npm ffmpeg
```

## Install

```bash
git clone <this-repo> storyboard
cd storyboard
./install.sh
```

This installs npm deps, a `systemd --user` service, a `~/.local/bin/storyboard` wrapper, and a `.desktop` launcher that opens `http://127.0.0.1:3200/`.

Default port is **3200** (override with `STORYBOARD_PORT`). Data and secrets live under `./data/` (gitignored).

```bash
# manual run
npm start

# tests
npm test

# uninstall service/launcher only
./uninstall.sh
```

## Features

### Boards / canvas
One board per video idea. Cards (`beat`, `note`, `clip`, `reference`, `audience`), groups/sections, wires, drag + pan/zoom, autosave via `PUT /api/boards/:id/canvas`.

### Notion sync
Settings → paste a Notion **internal integration** token and database id. Fetch schema, apply suggested property mapping, import rows as boards, push title/stage/mapped fields back with `last_edited_time` conflict detection (`409` unless `force`).

Suggested default mapping (names only — no personal database ids ship in the repo):

| App field | Common Notion property |
|-----------|------------------------|
| title | Video / Title / Name |
| stage | Stage / Status |
| persona | Persona |
| leave_behind | Leave-behind |
| link | Link |
| target_week | Target week |

### Local video
Browse disk paths or upload. Sources are never modified. Background jobs probe with ffprobe, build an H.264 720p AAC proxy, thumbnail strip, waveform peaks, and scene cuts → clip cards with in/out points. Cache key = file hash + mtime.

DaVinci Resolve Free on Linux often uses MKV / ProRes / DNxHR `.mov`; proxies make them playable in the browser.

### Timeline + pacing
Ordered beats with planned durations and optional clip in/out. Flags use simple rules: beat vs average length, long talking segments without visual change, hook window, planned vs target runtime.

### Audience fit
Per-board audience card (who / already know / promise / persona). Beats can be marked as not serving the promise; the side panel lists orphans.

### Work hours (optional)
Per-board cap (default 30h, configurable). Manual hour entries always work. Optionally enable ActivityWatch (`http://localhost:5600` by default, **off** by default, **read-only**): sum window-watcher time for Resolve / OBS (configurable), with per-board title keyword + start date filters. If AW is down, the UI degrades gracefully.

### Export
- Markdown script outline + shot list: `GET /api/export/:id/markdown`
- JSON board bundle import/export: `GET /api/export/:id/json`, `POST /api/export/import`

## API sketch

| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/api/boards` | List / create |
| GET/PATCH/DELETE | `/api/boards/:id` | Read / update / delete |
| PUT | `/api/boards/:id/canvas` | Autosave cards, wires, groups, beats |
| GET | `/api/boards/:id/pacing` | Pace curve + flags |
| GET/PUT | `/api/settings` | Local settings (token stored on disk only) |
| GET | `/api/notion/databases` | List DBs the integration can see |
| GET | `/api/notion/schema` | Schema + suggested mapping |
| POST | `/api/notion/import` | Pull ideas → boards |
| POST | `/api/notion/boards/:id/push` | Write back (conflict aware) |
| GET | `/api/files/browse` | Server-side path browser |
| POST | `/api/media/import-path` | Queue proxy/thumbs/scenes job |
| POST | `/api/media/upload` | Upload + queue |
| GET | `/api/media/:id/proxy` | Stream proxy MP4 |
| POST | `/api/media/:id/clip-cards` | Spawn scene cards |
| GET/POST | `/api/hours/:boardId` | Hours summary / manual entries |
| GET | `/api/export/:id/markdown` | Markdown export |
| GET/POST | `/api/jobs/:id` (+ `/cancel`) | Background job status |

## License

MIT
