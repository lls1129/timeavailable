# timeavailable

A small, self-hosted web app for finding a time that works for everyone (think When2Meet, without accounts).

- **Host** picks any set of dates (click or drag on a calendar, any combination), a daily time window, the meeting length (e.g. 3 hours) and the start-time step (every 15/30/60 min — a 3-hour meeting can start at 9:00, 9:30, 10:00…), or "whole days only", and can remove individual slots from the grid (lunch, early finish…). They get a share link and a private admin link.
- **Participants** open the link, sign in with just their name (optionally a password, so nobody else can edit their answer), and drag across a calendar-style week grid to select every time they're free (any rectangle of days × times; drag again to unselect; "available" or "if needed"). **Fill from Google Calendar** overlays their busy times on the grid and selects everything else. They can come back from any device, sign in with the same name, and edit.
- **Everyone** sees the group calendar with the number of free people in each slot, who is free in any slot, one person's availability on tap, and a ranked list of the best windows ("at least *k* people, for at least *n* minutes"). Times can be shown in any timezone; long polls page through days like a calendar.
- **The host picks the final time** by dragging over the group calendar. Everyone then sees a "Scheduled" banner with who is free, plus *Add to Google Calendar* and *.ics* links.

## Privacy model

The server **never** learns anything about anyone's calendar. Concretely:

1. The Google Calendar button runs entirely in the browser using Google Identity Services. The OAuth token is held in page memory only and is never sent to this server.
2. The browser asks Google only for the narrow scope `https://www.googleapis.com/auth/calendar.freebusy` ("View your availability in your calendars") and calls the `freeBusy` endpoint, which returns **only busy time ranges**, never event titles, attendees, or locations. So even the browser never sees event details.
3. The browser compares the busy ranges with the poll's slots locally and marks the free ones; the person can adjust before submitting.
4. The grant is revoked right after the lookup; the app does not keep any Google access.
5. The only thing ever sent to the server is `{ name, slots }` — the grid the person chose to submit. The server stores polls, names, and chosen slots in a local SQLite file; nothing else.

The page is served with a strict Content-Security-Policy whose `connect-src` only allows this server, Google's sign-in endpoints, and the `freeBusy` endpoint. The code is ~600 lines of plain JavaScript with no dependencies, so this is easy to audit: see `server.js`, `public/poll.js`.

## Three ways to host it

| | Cloudflare Worker (`worker.js`) — **recommended** | Node server (`server.js`) | Static mode (GitHub Pages, any file host) |
| --- | --- | --- | --- |
| Needs | A free Cloudflare account, set up from the browser | Node 22 + a persistent disk | Nothing — just the files in `public/` |
| Where answers live | Durable Object SQLite, one per poll | SQLite on the server | **Inside the link itself** |
| How people answer | Sign in with a name, save, come back any time | Same | Open the link, save, **post the updated link back** |
| Admin link, close poll, pick final time | Yes | Yes | Final time yes (host's browser), no admin link |
| Google Calendar import | Yes | Yes | Yes (same browser-only flow) |

All three serve the same pages; `config.js` tells the page which mode it is in. The API logic is one file, `lib/api.js`, shared by the Worker and the Node server.

### Cloudflare Worker (free, no command line needed)

1. Sign up / log in at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Import a repository** (connect your GitHub account if asked) and pick this repo. Wrangler config is in `wrangler.jsonc`, so keep the defaults: build command empty, deploy command `npx wrangler deploy`. Click **Deploy**.
3. The app is live at `https://timeavailable.<your-subdomain>.workers.dev`. Every push to `main` redeploys. Storage needs nothing extra: each poll is a Durable Object with its own SQLite database (included in the free plan).
4. Optional: set the Worker variable `GOOGLE_CLIENT_ID` (Settings → Variables) or edit `vars` in `wrangler.jsonc` to enable the Google Calendar button; add the `workers.dev` origin to the OAuth client. A custom domain can be attached under Settings → Domains.

From a computer, the same thing is `npx wrangler login && npx wrangler deploy`.

### Static mode on GitHub Pages

Static mode is the "no backend at all" option: the poll definition and every answer are compressed into the URL fragment (`poll.html#z…`). A poll with a dozen answers is well under 1 KB. Nothing is ever uploaded anywhere. The workflow is: the host shares link A; each person who saves gets link B that includes all answers so far and posts it back; the next person continues from the newest link. If people answer in parallel from the same link, any poll page can **Combine links from others** (merge by name, newest wins).

- **This repo:** every push to `main` that touches `public/` rebuilds the `gh-pages` branch (workflow in `.github/workflows/pages.yml`), which GitHub Pages serves at `https://<user>.github.io/timeavailable/`. The repo must be public (or on a paid plan). Set a repository variable `GOOGLE_CLIENT_ID` to enable the Google button.
- **Any existing Pages site:** copy the `public/` folder into the site repo (e.g. as `timeavailable/`). That's all; `public/config.js` already selects static mode. Put your client ID in that file to enable the Google button.

## Run locally

Requires Node.js 22.13+ (uses the built-in `node:sqlite`; no `npm install` needed).

```bash
node server.js
# → http://localhost:3000
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `DATA_DIR` | `./data` | Directory for the SQLite database (must be persistent in production) |
| `GOOGLE_CLIENT_ID` | *(empty)* | OAuth 2.0 Web client ID. If empty, the Google button is hidden and everything else still works. |

Tests: `npm test`.

## Deploy (tonight)

The app is a single container with one persistent directory. Any host that runs a Dockerfile and offers a volume works.

### Option A — Fly.io (recommended, ~5 minutes)

```bash
curl -L https://fly.io/install.sh | sh        # install flyctl, then: fly auth signup / fly auth login
fly launch --copy-config --no-deploy          # choose an app name + region; keep the Dockerfile
fly volumes create data --size 1              # persistent disk for the SQLite file (same region)
fly secrets set GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com   # optional, see below
fly deploy
```

Your app is now at `https://<app-name>.fly.dev`. (If `fly launch` renamed the app, that's fine — the `app` line in `fly.toml` is updated for you.)

### Option B — Render

Dashboard → **New → Blueprint** → select this repo. `render.yaml` defines the web service with a 1 GB persistent disk mounted at `/data`. Set `GOOGLE_CLIENT_ID` in the environment when prompted (or leave empty). Note: persistent disks are not available on Render's free tier.

### Option C — Railway

New project → Deploy from GitHub repo (it detects the Dockerfile). Add a **Volume** mounted at `/data`, and the variable `GOOGLE_CLIENT_ID` if you want calendar import. Generate a domain under *Settings → Networking*.

### Option D — Any VPS / Docker host

```bash
docker build -t timeavailable .
docker run -d --name timeavailable -p 80:3000 -v timeavailable-data:/data \
  -e GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com --restart unless-stopped timeavailable
```

Put it behind HTTPS (Caddy, nginx + certbot, Cloudflare…) — Google sign-in requires HTTPS on non-localhost origins.

## Enable the Google Calendar button

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → External → fill in app name, support email, developer email. Add the scope `https://www.googleapis.com/auth/calendar.freebusy` (shown as "View your availability in your calendars").
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add your deployed origin, e.g. `https://timeavailable.fly.dev` or `https://linshengliu.com` (and `http://localhost:3000` for local testing). No redirect URI is needed (the app uses the popup token flow).
5. Server mode: set the `GOOGLE_CLIENT_ID` environment variable and restart. Static mode: put the client ID in `config.js` next to the pages (or the `GOOGLE_CLIENT_ID` repository variable if you deploy with the included workflow).

**Testing vs. published consent screen.** While the consent screen's publishing status is *Testing*, only the Google accounts you list under *Test users* (up to 100) can use the button, and they'll see no warning. To open it to anyone tonight, click **Publish app**: users will then see Google's "unverified app" interstitial (click *Advanced → Go to … (unsafe)*) until you submit the app for verification. Calendar scopes count as *sensitive*, so verification takes a few days; it is not required for the app to work.

## How it works (for auditing)

- `lib/api.js` — the whole API: validation, sign-in (PBKDF2 password hashes), admin/edit keys (random, compared in constant time, sent only via headers), security headers. Platform-neutral: it talks to a small async storage adapter.
- `server.js` — Node HTTP server + `node:sqlite` adapter. `worker.js` + `wrangler.jsonc` — Cloudflare Worker + Durable Object SQLite adapter, static files from the assets binding.
- `public/slots.js` — shared timezone math. A slot is identified by its UTC epoch; grids are rendered in any timezone with `Intl`. DST is handled by converting each date's wall-clock time individually.
- `public/create.js` — host form, calendar date picker, grid preview with per-slot exclusion.
- `public/poll.js` — participant painting, Google free/busy import, heat map, best-time search, admin actions; in static mode it reads/writes the link fragment instead of the API.
- `public/common.js` — DOM helpers, grid rendering, and the link encoder (JSON → deflate-raw → base64url).

### API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/config` | – | Public config (Google client ID, limits) |
| `POST` | `/api/polls` | – | Create poll → `{id, adminKey}` |
| `GET` | `/api/polls/:id` | optional `X-Admin-Key` | Poll config + all responses (names and slots only) |
| `PATCH` | `/api/polls/:id` | `X-Admin-Key` | Edit title/description, close/reopen |
| `DELETE` | `/api/polls/:id` | `X-Admin-Key` | Delete poll and responses |
| `POST` | `/api/polls/:id/login` | – | Sign in `{name, password?}`; creates the response if the name is new → `{id, editKey, slots, locked, isNew}`. A password given the first time locks the name; a locked name requires it. |
| `POST` | `/api/polls/:id/responses` | – | One-shot submit `{name, slots}` → `{id, editKey}` (no sign-in) |
| `PUT` | `/api/polls/:id/responses/:rid` | `X-Edit-Key` or admin | Update own slots (and name) |
| `DELETE` | `/api/polls/:id/responses/:rid` | `X-Edit-Key` or admin | Remove response |

`slots` is an object mapping slot epoch (ms) → `1` (available) or `2` (if needed). Anything not in the poll's grid is dropped.

## License

MIT
