# timeavailable

A small, self-hosted web app for finding a time that works for everyone (think When2Meet, without accounts).

- **Host** picks any set of dates (click or drag on a calendar, any combination), a daily time window, the slot length (15 min … several hours, or custom), or "whole days only", and can remove individual slots from the grid (lunch, early finish…). They get a share link and a private admin link.
- **Participants** open the link, type a name, and paint the slots they're free ("available" or "if needed"), or click **Mark free times from Google Calendar** to pre-fill the grid from their calendar. They can come back and edit their answer from the same browser.
- **Everyone** sees a heat map of overlap, who is free in any slot, and a ranked list of the best windows ("at least *k* people, for at least *n* minutes"). Times can be shown in any timezone.

## Privacy model

The server **never** learns anything about anyone's calendar. Concretely:

1. The Google Calendar button runs entirely in the browser using Google Identity Services. The OAuth token is held in page memory only and is never sent to this server.
2. The browser asks Google only for the narrow scope `https://www.googleapis.com/auth/calendar.freebusy` ("View your availability in your calendars") and calls the `freeBusy` endpoint, which returns **only busy time ranges**, never event titles, attendees, or locations. So even the browser never sees event details.
3. The browser compares the busy ranges with the poll's slots locally and marks the free ones; the person can adjust before submitting.
4. The grant is revoked right after the lookup; the app does not keep any Google access.
5. The only thing ever sent to the server is `{ name, slots }` — the grid the person chose to submit. The server stores polls, names, and chosen slots in a local SQLite file; nothing else.

The page is served with a strict Content-Security-Policy whose `connect-src` only allows this server, Google's sign-in endpoints, and the `freeBusy` endpoint. The code is ~600 lines of plain JavaScript with no dependencies, so this is easy to audit: see `server.js`, `public/poll.js`.

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
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins** add your deployed origin, e.g. `https://timeavailable.fly.dev` (and `http://localhost:3000` for local testing). No redirect URI is needed (the app uses the popup token flow).
5. Copy the client ID into the `GOOGLE_CLIENT_ID` environment variable and redeploy/restart.

**Testing vs. published consent screen.** While the consent screen's publishing status is *Testing*, only the Google accounts you list under *Test users* (up to 100) can use the button, and they'll see no warning. To open it to anyone tonight, click **Publish app**: users will then see Google's "unverified app" interstitial (click *Advanced → Go to … (unsafe)*) until you submit the app for verification. Calendar scopes count as *sensitive*, so verification takes a few days; it is not required for the app to work.

## How it works (for auditing)

- `server.js` — HTTP server, static files, JSON API, SQLite (`polls`, `responses`). Admin and edit keys are random, stored server-side, compared in constant time, and sent only via headers.
- `public/slots.js` — shared timezone math. A slot is identified by its UTC epoch; grids are rendered in any timezone with `Intl`. DST is handled by converting each date's wall-clock time individually.
- `public/create.js` — host form, calendar date picker, grid preview with per-slot exclusion.
- `public/poll.js` — participant painting, Google free/busy import, heat map, best-time search, admin actions.

### API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/config` | – | Public config (Google client ID, limits) |
| `POST` | `/api/polls` | – | Create poll → `{id, adminKey}` |
| `GET` | `/api/polls/:id` | optional `X-Admin-Key` | Poll config + all responses (names and slots only) |
| `PATCH` | `/api/polls/:id` | `X-Admin-Key` | Edit title/description, close/reopen |
| `DELETE` | `/api/polls/:id` | `X-Admin-Key` | Delete poll and responses |
| `POST` | `/api/polls/:id/responses` | – | Submit `{name, slots}` → `{id, editKey}` |
| `PUT` | `/api/polls/:id/responses/:rid` | `X-Edit-Key` or admin | Update own response |
| `DELETE` | `/api/polls/:id/responses/:rid` | `X-Edit-Key` or admin | Remove response |

`slots` is an object mapping slot epoch (ms) → `1` (available) or `2` (if needed). Anything not in the poll's grid is dropped.

## License

MIT
