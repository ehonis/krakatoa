# Self-hosting Krakatoa

This covers the operational side the README keeps short. [AGENTS.md](../AGENTS.md)
explains why each decision was made. This page covers how to run it.

## Build and run

```bash
npm install      # runs `npm install` in app/ as well
npm start        # npm run build, then node server/server.js on port 8101
```

`npm run serve` starts the server without rebuilding. The server serves `dist/`
straight off disk, so **app changes are not live until `npm run build` runs**.
Server changes need a restart. The asset hash in `dist/index.html`
(`grep -o 'assets/[^"]*' dist/index.html`) tells you which build is being served.

Optional system packages: `pdftotext`/`pdfinfo` (poppler-utils), used when Ask
AI learns a chain menu from a PDF and when regenerating the Panera menu.

### Docker

`docker compose up -d --build` builds the image and keeps `data/` in the
`krakatoa-data` volume. The setup link is printed in `docker compose logs`.
Build arg `WITH_CLAUDE=1` installs the Claude Code CLI in the image. The
`claude-home` volume then keeps its sign-in (`docker compose exec krakatoa claude`)
across rebuilds. Or skip the sign-in and paste an API key in Settings → AI.
Compose reads `.env` if one exists.

### As a systemd user service

Only the web service is needed. Krakatoa ships no timers or scheduled jobs.
`~/.config/systemd/user/krakatoa.service`:

```ini
[Unit]
Description=Krakatoa food log
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/krakatoa
# Node is often not on systemd's PATH (nvm, for example): use an absolute path.
ExecStart=/usr/bin/node %h/krakatoa/server/server.js
EnvironmentFile=-%h/krakatoa/.env
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now krakatoa
journalctl --user -u krakatoa -n 20     # the setup link on first run
```

### Moving to a new hostname

A phone's offline log is stored per origin. If the app moves address, build it
with `VITE_KRAKATOA_LEGACY_HOSTS="old.example.com=new.example.com"` (in
`app/.env.local` or the build environment) and keep serving the old address for
a while. A page opened there pushes its local log, then moves to the new one.

## Sign-in

There is one owner account per install.

- **First run.** With no owner yet, the server prints
  `…/setup?token=<random>` to stdout. Only that link opens `/setup`. Restarting
  prints a fresh token, and the token stops working once the owner exists. Until
  then every other page answers "not set up" and every API call answers 401.
- **Password.** It is hashed with scrypt and stored in `data/owner.json`
  (mode 0600) with the key that signs sessions and a session version. Signing
  out moves the version on, which ends every session, including any copy of
  the cookie. Signing out in the app also takes the log off that device:
  it pushes anything unsynced first, asks before discarding entries the server
  never received (saying how many), then clears the app's local storage and
  any data caches, in every open tab. The offline shell cache, which holds no
  log data, stays. If the server does not confirm the sign-out, nothing is
  removed and the app offers to try again. Changing the password does the same and rotates the key. If you forget it, stop the
  server, delete `data/owner.json`, and start again for a new setup link. The
  log is not touched.
- **Sessions** are signed, httpOnly, `SameSite=Lax` cookies that last 30 days.
  They are marked `Secure` when the request arrived over https (directly,
  through `X-Forwarded-Proto: https`, or because `KRAKATOA_PUBLIC_URL` is https).
- **Lockout.** Ten failed sign-ins from one address in 15 minutes make that
  address wait. A hundred from everyone together pause sign-in for everyone.
  The address is the TCP peer. `X-Forwarded-For` and `CF-Connecting-IP` are
  only believed when the peer is this machine (a local proxy or cloudflared),
  or always with `KRAKATOA_TRUST_PROXY=1`, or never with `KRAKATOA_TRUST_PROXY=0`.
- **Cross-site requests.** Any non-GET request whose `Origin` or
  `Sec-Fetch-Site` shows another site is refused (403), and a JSON body must be
  sent as `application/json` (otherwise 415). Bearer-token clients, which send
  no `Origin`, are unaffected.
- **Machine callers.** MCP clients and scripts send
  `Authorization: Bearer <token>`. The token comes from Settings → Access, or
  from `KRAKATOA_API_TOKEN`. The Totem bridge secret is accepted as well, so a
  Totem gateway that already holds it needs nothing new. A token can use the
  API and the MCP, and read Settings, but **cannot change Settings**: that
  needs a signed-in browser.
- **Behind an authenticating proxy** (Cloudflare Access, oauth2-proxy, and so
  on), set `KRAKATOA_AUTH=proxy` to turn the built-in sign-in off. The server
  then trusts every request that reaches it, so make sure only the proxy can
  reach the port. It prints a warning at startup when it listens on anything
  but loopback. In proxy mode, changing Settings (and the Test buttons) is
  only allowed for connections from this machine, which is where cloudflared
  or a local reverse proxy connects from. Someone reaching the port directly
  over the LAN or a tailnet can read the log and Settings but cannot change
  Settings.

### Upgrading an install from before sign-in existed

The first time the new code starts against a data dir that already has a log
(`data/state.json`) and no `data/settings.json`, it writes `data/settings.json`
with the Totem bridge and the digest file still on. If there is no
`data/owner.json` either, the install predates sign-in, so sign-in is left in
proxy mode. An owner account means built-in sign-in, never proxy. If
`$HOME/projects/personal-assistant/.env` exists, it is recorded as the place
the bridge secret is read from; there is no default for that path otherwise. That is how the install
already behaved, so it keeps working with no env change. The one exception is
WHOOP: it used to come through the Totem bridge and now comes from Bushido, so
an install that showed WHOOP's burn needs `BUSHIDO_API_URL` and
`BUSHIDO_API_TOKEN` (or Settings) to keep it. To switch to built-in
sign-in later, set `KRAKATOA_AUTH=builtin` and use the printed setup link.

## Configuration

Everything is optional, and most of it is set in the browser under **Settings**.
The values are stored in `data/settings.json` (mode 0600). Stored keys are never
sent back to the browser; Settings shows them masked. Every setting also has an
environment variable, listed with its default in
[`.env.example`](../.env.example). A variable that is set always wins, and
Settings shows that field as locked. The server reads `process.env` only. It
does not load `.env` by itself, so use `node --env-file=.env`, a systemd
`EnvironmentFile=`, or compose.

Installs from before Settings existed may have keys in `data/config.json`. That
file is still read, with lower priority than Settings and env, but it is never
written:

```json
{
  "usdaKey": "…",
  "nutritionixId": "…",
  "nutritionixKey": "…"
}
```

- **USDA**: without a key, lookups use `DEMO_KEY` at about 30 requests an hour.
  After a refusal, USDA rests for 15 minutes. A free key raises the limit to
  1,000 an hour.
- **Open Food Facts** needs no key.
- **Nutritionix**: the integration is still there, but it stays dormant because
  Nutritionix closed its free tier. Chain menus don't depend on it.

There are no OAuth integrations in this app, so there are no redirect URIs to
register. WHOOP is reached only through Bushido (below).

### Label reader and Ask AI

Both features run the Claude Code CLI headlessly, with its tools restricted by
flag. Settings → AI shows whether `claude` is installed (at
`$HOME/.local/bin/claude`, on `PATH`, or at `CLAUDE_BIN`; the path is
read-only in the browser, because the server runs it) and whether it
is signed in, according to `claude auth status`. The **Test** button asks the
model for a one-word reply. To use an Anthropic API key instead of a sign-in,
paste it there. It is passed to the CLI as `ANTHROPIC_API_KEY`. Models and
effort can be chosen there too; the defaults are `claude-sonnet-5` and
`medium`. Without the CLI, the label form still works by hand, and the photo
and Ask AI screens show a "Set up AI in Settings" prompt.

### WHOOP, through Bushido

Krakatoa holds no WHOOP credentials. It can read the day's burn from Bushido,
the author's training app, which holds the WHOOP grant: Krakatoa sends
`POST <BUSHIDO_API_URL>/api/whoop/owner` with
`Authorization: Bearer <BUSHIDO_API_TOKEN>` and the body
`{ "method": "training", "args": [{ "days": 30 }] }`, and keeps only the daily
calories (and the body weight) from the answer. This is **off until both a URL
and a token are set**, in Settings → WHOOP, through Bushido, or with
`BUSHIDO_API_URL` (a loopback address such as `http://127.0.0.1:8099` is
typical) and `BUSHIDO_API_TOKEN`. There is no default URL. While it is off,
Krakatoa never contacts Bushido, `/api/whoop` answers `configured: false`, and
the day screen has no energy panel. Bushido's error text (its "no WHOOP set
up", a wrong token, a rate limit, or WHOOP's own "reconnect WHOOP") is shown
beside the refresh button as it arrives. Changing the URL in Settings stops the
existing token from being sent: enter the token for the new URL along with it.

Anyone running this without Bushido could replace `server/whoop.js` with a
reader for some other source of daily energy expenditure.

### Totem bridge: the habit push

Krakatoa can write one habit record per logged day to a bridge run by the
author's personal assistant, Totem. This is **off on a fresh install**. While
it is off, Krakatoa never contacts the bridge. Turn it on in Settings → Totem
bridge, or with `KRAKATOA_TOTEM=1` or `KRAKATOA_TOTEM_URL`. It
needs a bridge URL (default `http://127.0.0.1:8787`) and the bridge secret: either
`BRIDGE_SECRET`, one pasted in Settings, or the `BRIDGE_SECRET=` line of Totem's
`.env` (`KRAKATOA_TOTEM_ENV`, which has no default). Changing the bridge URL in
Settings stops any existing secret from being sent: enter the secret for the new
URL along with it. To create the habit once, run `node server/totem.js --ensure`;
the Test button checks that the habit is there.

### MCP

`POST /mcp` serves MCP Streamable HTTP (JSON replies). To connect an MCP client
that supports HTTP servers, create a token in Settings → Access and send it as a
bearer token:

```json
{ "transport": "http", "url": "http://127.0.0.1:8101/mcp", "headers": { "Authorization": "Bearer <token>" } }
```

In proxy mode no token is needed.

## Data and backups

`data/` is gitignored and **`data/state.json` is the real log**. Don't hand-edit
it. To back up, use the export endpoint rather than copying files:

```bash
curl -s -H "Authorization: Bearer $KRAKATOA_TOKEN" localhost:8101/api/export > krakatoa-export.json
```

Use the API token from Settings → Access; with `KRAKATOA_AUTH=proxy`, leave the
header off. Signed in, opening `/api/export` in the browser downloads the same
file. `POST /api/import` restores an export. The server also keeps up to 60 rolling
copies in `data/backups/` before overwriting state.

These are disposable caches, safe to delete:

- `data/foods.json` holds every food that has resolved
- `data/images/` holds proxied product photos
- `data/whoop.json` mirrors Bushido's WHOOP figures

`data/ai/` holds Ask AI threads and their photos. `data/menus/learned.json` holds
menus Ask AI has learned. `data/settings.json` and `data/owner.json` hold the
configuration and the owner account. Both are mode 0600, and neither is in an
export. `data/digest.json` is written only when the digest file is switched
on. It is a compact rollup that other tools can read so they don't have to
parse `state.json`.

## Regenerating the content files

`content/` is generated. Don't edit it by hand; re-run the scripts.

```bash
# Generic foods, from the USDA SR Legacy bulk download (URL in the script).
curl -sL -o /tmp/fdc_sr.zip <URL from scripts/basics.build.mjs>
npm run build:basics
```

### Restaurant menus (optional)

`content/restaurants.json` holds the chain menus behind the bowl and order
builder. It may not be included in your copy. Everything else works without
it: the menu screen says no menus are built, Ask AI and the MCP simply have no
chain rows, and Ask AI can still learn a chain from its own nutrition page.

Whether to build it is up to you. The build script reads each chain's own
published nutrition information: PDFs and data files from the chains' sites,
and for some chains copies kept by the Internet Archive. Check each site's
terms before running it. The resulting data belongs to the chains and is not
covered by this repository's MIT license.

```bash
npm run build:menus                    # every chain
npm run build:menus -- culvers panera  # just these; the others are kept as built
```

It needs network access and `pdftotext` (poppler-utils). The McDonald's
harvest reads Internet Archive captures; it is slow and can be resumed (it
caches progress under `$TMPDIR`, and `MCD_RETRY=1` retries captures that failed
before). The server picks the file up without a restart.

## Data sources

| File | Source | Notes |
|---|---|---|
| `content/basics.json` | [USDA FoodData Central, SR Legacy](https://fdc.nal.usda.gov/) | US government data, public domain |
| `content/restaurants.json`, if built (Chipotle) | Chipotle's nutrition PDF (dated 2024-10-16) | the chain's published nutrition |
| (Bibibop) | Bibibop's nutrition PDF (updated 2026-08-19) | the chain's published nutrition |
| (Culver's) | The hosted menu file behind Culver's own nutrition guide | the chain's published nutrition |
| (McDonald's) | McDonald's nutrition-calculator data, as captured by the Internet Archive | captures 2024-05 to 2026-09 |
| (Panera) | Panera's nutrition guide PDF (effective 2026-06-17), as captured by the Internet Archive | |
| (Balance Pan-Asian Grille) | Balance's former nutrition page, as captured by the Internet Archive (2025-07-21) | |

Every chain entry in `restaurants.json` records its source URL and date. The
restaurant figures belong to the respective chains and are not covered by this
repository's MIT license.

## Deploying every merge (optional)

`.github/workflows/deploy.yml` deploys `main` after CI passes on it. It runs on a
[self-hosted GitHub Actions runner](https://docs.github.com/actions/hosting-your-own-runners)
on the machine that serves the app, so nothing has to reach that machine from outside.
Each deploy:

1. stops if the live checkout has uncommitted changes to tracked files or is not on `main`;
2. fast-forwards it to `origin/main` (nothing new, nothing done), runs `npm ci` only if a
   `package.json` or lockfile changed, and builds;
3. restarts the service (`launchctl kickstart -k` on macOS,
   `systemctl --user restart` on Linux), then waits up to a minute for the health URL;
4. if the build, the restart or the health check fails, resets to the commit it started
   from, builds that and restarts again.

When the iPhone app changed (`mobile/`), a second job ships it. It publishes an over-the-air
update to the `production` channel; installed builds take it only when their native code
matches (the runtime version is a fingerprint). When no App Store build has that
fingerprint yet, it also starts one with `--auto-submit`, so it lands in TestFlight.

It does nothing until the repository is told where the install is:

```bash
# On the serving machine, as the user the service runs as: a runner for this repository
# with the label the workflow asks for (Settings → Actions → Runners → New self-hosted
# runner gives the download and the token).
./config.sh --url https://github.com/<you>/<repo> --token <token> --labels krakatoa-deploy --no-default-labels
./svc.sh install && ./svc.sh start
# Give it the PATH npm needs, in .env beside config.sh, e.g.:
#   PATH=/opt/homebrew/opt/node/bin:/opt/homebrew/bin:/usr/bin:/bin

# Repository variables (Settings → Secrets and variables → Actions):
gh variable set DEPLOY_DIR -b /path/to/the/live/checkout
gh variable set DEPLOY_SERVICE -b krakatoa            # the launchd label or systemd unit
gh variable set DEPLOY_HEALTH_URL -b http://127.0.0.1:8101/api/health   # the default

# Optional, for the iPhone app:
gh variable set EAS_PROJECT_ID -b <project id>       # what mobile/app.local.json holds
gh variable set IOS_BUNDLE_ID -b <bundle id>
gh secret set EXPO_TOKEN                             # an Expo access token
```

Run one by hand from the Actions tab (Deploy → Run workflow) or with
`gh workflow run deploy.yml`. Only people who can push to the repository can trigger it, so
use it on a private repository you control: a self-hosted runner runs whatever a workflow
on that repository asks of it.
