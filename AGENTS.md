# AGENTS.md — Krakatoa

A self-hosted food log for one owner. Scan, search, pick a generic food, build a
chain order, photograph a label or a receipt, and see whether the day came out
under or over.

**If AGENTS.local.md exists, read it too: it holds the owner's deployment-specific notes.**

This file is the engineering guide: where things are, the conventions, and the
decisions worth not undoing, each with the reason it went that way.

---

## 1. What it is

A zero-dependency Node server (built-ins only) and a React/Vite PWA. The server
serves the built app from `dist/` and a small JSON API backed by one file on
disk. Default port **8101**.

| Thing | Path |
|---|---|
| HTTP, store, merge, food cache, auth gate | `server/server.js` |
| Single-owner sign-in: setup token, scrypt, signed cookies | `server/auth.js` |
| The sign-in, setup and not-set-up pages (no script) | `server/pages.js` |
| Settings: env > `data/settings.json` > old `data/config.json` | `server/settings.js` |
| Settings screen | `app/src/settings.jsx` |
| `/api/me`, the 401 redirect, `openSettings()` | `app/src/lib/server.js` |
| Normalizers — OFF and USDA into one food shape | `server/nutrition.js` |
| The two databases, the fallback chain, search | `server/lookup.js` |
| Day rollup + the digest other tools may read | `server/digest.js` |
| The little square beside a food | `app/src/thumb.jsx` |
| The macro pie and the water meter | `app/src/lib/macros.js` + `app/src/water.jsx` |
| One food: fix this entry, and every time you had it | `app/src/foodview.jsx` |
| Combos (saved meals) — the model | `app/src/lib/combos.js` |
| Combos — the builder | `app/src/mealbuilder.jsx` |
| The generic foods | `content/basics.json` + `app/src/lib/basics.js` |
| …and the script that generates them | `scripts/basics.build.mjs` |
| Optional Totem bridge: habit push | `server/totem.js` |
| Optional Totem bridge: WHOOP's daily burn, and the deficit | `server/whoop.js` + `app/src/lib/whoop.js` |
| Chain menus (OPTIONAL file: every reader must cope with it absent) | `scripts/restaurants.build.mjs` → `content/restaurants.json` |
| …one reader per way a chain publishes | `scripts/restaurants/*.mjs` |
| …and the bowl or order built from one | `app/src/lib/restaurants.js` + `app/src/bowl.jsx` |
| A food from its Nutrition Facts label — the form | `app/src/labelfood.jsx` + `app/src/lib/label.js` |
| …and the photo reader (a headless `claude` run) | `server/label.js` |
| Ask AI — a receipt, a plate or words, to a list to review | `app/src/ask.jsx` + `app/src/lib/ask.js` |
| …and the run behind it, with Krakatoa's food table | `server/ai.js` |
| …in the background: threads and the runner | `server/aithreads.js` + `app/src/lib/askapi.js` |
| Menus Ask AI learned, and the page check | `server/learned.js` → `data/menus/learned.json` |
| The MCP server, at `POST /mcp` | `server/mcp.js` |
| Nutritionix (dormant — free tier closed) | `server/nutritionix.js` |
| Client store (offline-first, last-write-wins) | `app/src/lib/store.js` |
| The arithmetic, client side | `app/src/lib/food.js` |
| The day screen | `app/src/today.jsx` |
| Scan / search / recents / by hand | `app/src/add.jsx` |
| The camera | `app/src/scanner.jsx` |
| The iPhone app (Expo; its own install, read `mobile/AGENTS.md`) | `mobile/` |
| An overlay, and what it becomes on a desktop | `app/src/overlay.jsx` |
| Runtime state — **gitignored, this is the real log** | `data/state.json` |
| Owner account and settings — **0600** | `data/owner.json`, `data/settings.json` |
| Cached product photos — disposable, one JPEG per gtin | `data/images/` |

```bash
npm install && npm start    # installs app/ deps, builds, serves on 8101
npm test                    # lint + every suite, including sign-in and fresh-install
npm run build               # emits dist/ — A CHANGE IS NOT LIVE UNTIL YOU BUILD
node scripts/basics.build.mjs           # regenerate the generic-food catalog
npm run build:menus                     # optional chain menus (or name some: -- culvers chipotle)
```

Operational detail (Docker, a systemd unit, backups, every env var) is in
`docs/self-hosting.md` and `.env.example`.

**`npm test` starts with `eslint src`, and it is one rule: `rules-of-hooks`.**
It caught a real crash the hour it went in: `FoodView` called a `useMemo` below
an early return, so the hook count changed the moment the store hydrated and
React blanked the whole app with a minified #310. No render test can see that:
server rendering runs each component once, with a fresh instance, so both
branches render perfectly on their own. Do not add a style config around it;
formatting opinions would bury the one rule that matters.

**`dist/` is served off disk, so `npm run build` is the step that makes app
changes real.** Code in the repo, passing every test, while the phone runs a
weeks-old bundle is a real failure mode. `grep -o 'assets/[^"]*' dist/index.html`
shows which build is being served.

## 2. Sign-in, Settings, and what is off by default

### Sign-in (`server/auth.js`)

- **One owner.** With no owner, the server prints a one-time
  `/setup?token=<random>` link to stdout on every start, and only that link
  opens `/setup`. Someone who can reach the port but not read the log cannot
  claim the install. The token dies when the owner is created.
- **Password**: scrypt (node:crypto), stored in `data/owner.json` (0600) with the
  key that signs sessions. Changing the password rotates the key, which signs
  out every other device.
- **Sessions**: signed, httpOnly, `SameSite=Lax` cookies, `Secure` when the
  request is https (directly, `X-Forwarded-Proto`, or an https
  `KRAKATOA_PUBLIC_URL`). Each carries the owner's `sessionVersion`, checked on
  every request; sign-out and password change bump it, so a copied cookie dies
  too. `parseCookies` never decodes; only our cookie is decoded, in a try.
- **Lockout**: ten failures per address and a hundred globally per 15 minutes,
  in a bounded map. The address is the socket peer; forwarded-for headers count
  only from a trusted proxy (`KRAKATOA_TRUST_PROXY`, or a loopback peer).
- **CSRF**: a non-GET whose `Origin`/`Sec-Fetch-Site` is cross-site is refused
  before routing, including `/mcp`; JSON bodies must be `application/json`
  (`readBody` answers 415). Bearer clients send no Origin and are unaffected.
- **Sign-out clears the device** (`lib/signout.js`): flush, count what the
  server still lacks, confirm with that count, then `/api/auth/logout` (which
  sends `Clear-Site-Data: "cache"`) and clear `krakatoa.*` storage, IndexedDB and
  non-shell caches, but only after the server confirms the logout (2xx, or 401);
  otherwise nothing is cleared and the button offers a retry. A
  `krakatoa.signingOut` freeze (two-minute expiry) stops every tab writing
  BEFORE the final read, flush and count, and is lifted if sign-out does not
  happen. A `krakatoa.signedOut` marker (plus a BroadcastChannel message) tells every tab;
  `makeLocalPersist` refuses localStorage writes while it is set, and
  `/api/me` with a user clears it. Proxy mode has no sign-out. Tested in
  `app/signout.test.js`.
- **`safeNext`** parses with `new URL` against a dummy origin and rejects
  backslashes. Do not go back to a regex.
- **Machine callers** (MCP clients, scripts) use `Authorization: Bearer <token>`:
  the API token from Settings (`KRAKATOA_API_TOKEN`), or the Totem bridge
  secret. A bearer opens `/api/*` and `/mcp`, never the pages.
- **The iPhone app** (`mobile/`) signs in with the owner's password like a
  browser, but sends `X-Krakatoa-Client: native` and gets the session in the
  JSON reply instead of a cookie (also on a password change). It sends it back
  as `X-Krakatoa-Session`, which `readSession` accepts when there is no cookie.
  It is a session, not a token: Settings writes work, sign-out ends it. A
  browser cannot send that header cross-site without a CORS preflight, which
  this server never answers. Tested in `auth.test.js` and `install.test.js`.
- **`KRAKATOA_AUTH=proxy`** turns sign-in off for an install already behind an
  authenticating proxy. Then the proxy is the whole trust boundary.
- The gate is in `server.js` (`authRoutes`, then `gate`). Icons, the manifest
  and `sw.js` are public; everything else needs a session, a bearer, or proxy
  mode. A 401 from `/api` sends the browser to `/login` (`installAuthRedirect`).
- Auth mode is **not** editable from the browser. `cleanPatch` in
  `settings.js` is an allowlist; anything not in `EDITABLE` is dropped. Paths
  the server executes or reads (`ai.bin`, `totem.envFile`) are deliberately
  absent: env or a hand-edited settings file only.
- **Settings writes and Test** need a browser session (`req.via === 'session'`),
  never a bearer token; in proxy mode they need a loopback peer
  (`settingsWriteRefused`). Proxy mode on a non-loopback bind logs a warning.
- **A changed bridge URL** sets `totem.ownSecretOnly` (`guardTotemUrl`), so
  neither `BRIDGE_SECRET` nor Totem's .env is sent to the new host; only a
  secret entered for it.

### Settings (`server/settings.js`, `app/src/settings.jsx`)

Three layers, highest first: **env**, `data/settings.json` (written by the
Settings screen, 0600), then the older `data/config.json` (read, never written).
`effective()` is read fresh on every use, so a change needs no restart.

- A field set by env shows **locked** in Settings with the variable's name. An
  editable box that changes nothing would be a lie.
- **Secrets never go back to the browser.** `publicView` masks them; a masked
  value sent back is ignored, so it can never overwrite the real one.
- AI: the only backend the code drives is the **Claude Code CLI**. Settings
  shows whether it is installed and signed in (`claude auth status`, of which
  only `loggedIn` and the method reach the browser). A stored API key is passed
  to the CLI's environment as `ANTHROPIC_API_KEY` (`aiEnv`). Test asks the model
  for a one-word reply.

### Off by default, and existing installs

A fresh install is a blank canvas: an empty log, no targets (water draws against
64 oz so the glass has something to be a fraction of), and **everything that
reaches outside the app off**:

- **AI.** Without a CLI, `/api/label` and `/api/ask` answer 503 with
  `setup: 'ai'`, and the screens show "Set up AI in Settings" instead of an error.
- **The Totem bridge** (WHOOP burn and the habit push). While off, nothing
  contacts it, `/api/whoop` answers `configured: false`, and the day has no
  energy panel. `totemConfig()` returning null is the off switch everywhere.
- **The digest file** (`data/digest.json`). `/api/digest` still answers live.

`settings.migrate()` runs once per data dir (when `settings.json` is absent).
**A data dir that already has `state.json` is an existing install** and gets the
bridge and the digest on. With no `owner.json` it predates sign-in and gets
`auth.mode: proxy`; **with an `owner.json` it never gets proxy**. The legacy
Totem `.env` path is recorded only if that file exists; it has no default.
Nobody upgrading should find their setup switched off. The "off" defaults are
for fresh installs only. `server/install.test.js` boots real servers for all
three paths (fresh, proxy, existing). Keep it passing.

There is no `examples/` directory and nothing is seeded: `content/` is generic
(USDA foods and chain menus), and there are no timers, jobs or scheduled tasks.
The only background work is a WHOOP refresh on read when the bridge is on, and
resuming Ask AI threads that were mid-run at restart.

## 3. A barcode carries no nutrition, and that is the whole design

The barcode is an identifier, twelve or thirteen digits and nothing else. Every
number comes from a database lookup on it, and both databases are free:

- **Open Food Facts**: keyless, crowdsourced, ~3M products. Tried first.
- **USDA FoodData Central**: manufacturer label submissions, US-only, needs a
  key (`DEMO_KEY` works at ~30/hour; a free key lifts it to 1000/hour).

**They miss different things and that is why both are wired.** Coca-Cola
`049000042566` is in OFF and not in USDA; USDA has branded rows OFF has never
seen. A chain of one would have looked fine in testing and failed in a shop.

Four decisions worth not undoing:

- **A GTIN is validated, check digit and all** (`normalizeGtin`). USDA carries
  placeholder rows whose `gtinUpc` is a run of zeros, and before the checksum
  went in, an unreadable scan of `0000000000000` came back as tortilla chips. It
  also turns a typo in the manual box into "that is not a barcode" instead of a
  wrong food.
- **Both GTIN forms are tried.** The same barcode reads as 12 digits (UPC-A) or
  13 (EAN-13) depending on the scanner, and the two databases store different
  ones. This is the commonest reason a scan reads as "not in the database" when
  the product is right there.
- **Energy with no unit is kJ**, by OFF's own convention. Reading `energy_100g`
  as kcal makes a biscuit look like a day's food and nothing on screen looks
  wrong. Same class of trap: OFF publishes sodium in GRAMS.
- **USDA nutrients are per 100 g even when the label is not**, so the serving
  portion is scaled, and only when `servingSizeUnit` is grams. Scaling by
  millilitres would be a guess about density.

**Search is scoped to the US shelf** (`countries_tags`), while barcode lookup
stays on `world`: a product in hand is in hand wherever it was sold. Both
databases are queried **in parallel and interleaved**. Running USDA only when OFF
came up short meant it never ran, because OFF fills the page every time.

**Search robustness**, each from a measured failure:

- With no USDA key, `DEMO_KEY` is shared and refuses with 429. A refusal rests
  USDA for 15 minutes (`usdaResting`) and says so in `tried`.
- OFF's old `cgi/search.pl` is the endpoint it rate-limits hardest. Search goes
  to search.openfoodfacts.org first, the old one is the fallback, and each gets
  one retry on a 5xx. That service sends `brands` as a LIST.
- **A stale answer could overwrite a fresh one.** Every client request is
  aborted when the query moves on.
- **"Nothing found" meant two things.** When every database errors, the screen
  says the databases did not answer and offers a retry.
- Searches are cached server-side (20 min whole, 1 min partial, never an outage)
  and a query in flight is shared.

## 4. Conventions

- **A portion is a label, not a weight.** A food is an identity plus a list of
  portions, each carrying the macros for ONE of it. The real-world serving leads;
  leading with 100 g is how a tracker gets you to log 100 g of a 68 g bar.
- **A food with no energy figure is a MISS, not an empty food.** OFF has entries
  that are a photo and a name; returning one would log silently as nothing.
- **Macros are stored on the entry, not derived.** Computed at log time from the
  portion and quantity, so a database editing a product upstream cannot change
  what a past day totalled.
- **A target nobody set is not a target of zero.** `remaining` is null with no
  target, because "0 left" and "no target" are different states and only one
  should turn a ring red.
- **The average is over days LOGGED, not over the window.** A day the app was
  not opened is missing data; averaging it in as zero reads as a crash diet.
- **Recents lead the add screen.** Scan, search, recent and by-hand all land on
  the same detail screen and produce one shape of entry.
- **Macros are optional on the manual form; calories are not.**
- **Offline first.** Every write lands in `localStorage` before it syncs; the
  server merges per entry by `updatedAt`, newest wins. No conflict dialogs. The
  phone pulls on every return to the foreground and once a minute, because an
  installed PWA resumed from the switcher does not reload.
- **A component must never hold a COPY of an entry**; derive it from `entries`
  every render. It renders perfectly while being wrong, so no test catches it.
- **A number box is a text box that owns its text.** `Stepper` keeps what was
  typed; a controlled input running `Number()` per keystroke turns "1." into 1.
  Do not put `type="number"` back on it.
- **The camera needs a SECURE context.** `getUserMedia` returns nothing over
  plain http to a bare IP. `BarcodeDetector` is the fast path where it exists;
  **Safari does not have it**, so zxing-wasm is the plan. The `.wasm` is
  imported with `?url` so it is served from this origin; left alone the library
  fetches it from a CDN.
- **`data/` is gitignored and `state.json` is the real log.** Never delete or
  hand-edit it; back it up with `GET /api/export`. `data/foods.json` is a CACHE
  of everything that ever resolved.

## 5. Pictures, and looking a food up by name

**Photos come from Open Food Facts** (front-of-pack at 100/200/400 px; 200 for a
thumbnail on a 3x phone). USDA has none.

- **They are PROXIED, never an `<img>` at OFF's CDN.** `GET /api/image?gtin=`
  fetches once to `data/images/<gtin>.jpg`. It works offline the second time, it
  is same-origin so the service worker caches it, and the owner's shopping does
  not become a request log on someone else's CDN. The `u` hint is checked
  against a host allowlist; an open fetch proxy is an open relay.
- **A GTIN is enough to ask.** With no known image URL the server re-reads the
  product, which is what backfills foods logged before photos existed.
- **`node:https`, not `fetch`.** OFF's image CDN can take 10–15 s to finish a TLS
  connect, and undici (global `fetch`) has a hard-coded 10 s connect timeout. Do
  not "simplify" this back to `fetch`.
- **Nothing waits for a photo.** `primeImage` pulls in the background when a
  barcode resolves and for the top 8 of a search, one in-flight download per gtin.

**The letter tile is the fallback UI, not a placeholder.** Every food gets a
square; a ragged left edge is harder to scan than no pictures. Colour and letter
come off the FULL title including the brand, hue hashed from it. Taking the
letter from the name alone rendered eight USDA yoghurts as eight "G" tiles.

**The by-hand lookup** (`LookupHelper` in `add.jsx`) **does not search until
asked**, and tapping a result FILLS THE BOXES rather than jumping away, because
this is where near-misses land and every number stays editable. What it filled
is **labelled**: a value the user did not type must never look like one they did.

## 6. Basics, combos, stars, and the screen for one food

### The basics catalog — 299 generic foods

`content/basics.json`, generated by `scripts/basics.build.mjs` from **USDA SR
Legacy** (bulk JSON, no key, ~7,800 foods, and household portions with gram
weights). Every row carries its `fdcId`.

- **The numbers are never typed by hand.** Edit the `CATALOG` in the script and
  re-run. A name that fails to match USDA is printed loudly, not dropped.
- **Portions are ordered by what looks like ONE SERVING** (calorie proximity to
  ~180 kcal), not by unit. Ranking by unit led every fat with "1 cup" — 1,628 kcal
  of butter. `combos.test.js` pins that nothing leads with more than 900 kcal.
- **Item nouns are portions** (`ITEM_NOUNS`: doughnut, cookie, inch sub,
  drumstick…) and rank with the size words. **"serving" ranks last**: USDA's
  "1 NLEA serving" otherwise replaced "1 cup" on produce. **Nothing over 1,500
  kcal is offered** except 100 g (a whole pie is never "a slice"). Labels are
  cleaned, never invented.
- **It is searched locally**: fetched once and kept, so basics answer instantly
  and offline, above the network results.

### Combos

On screen "combos"; breakfast, lunch, dinner and snack are still meals. A meal is
WHEN, a combo is WHAT. The data was always `kind: 'combo'`; the file and
component are still `mealbuilder.jsx` / `MealBuilder`.

- **Logging one writes ONE food entry**, carrying its `components`, so it is one
  row to delete and every reader downstream keeps working unchanged.
- **The path that gets used is "save what I just logged"** (*Save this … as a
  combo* on any meal section with more than one row). The builder is the second door.
- Combos do not nest.

### Stars

`kind: 'star'`: findable in one tap forever, **including before it was ever
logged**, which is why the star lives on the food detail screen.

### One screen for one food

`foodview.jsx`: the food at the top, the controls for ONE logged entry under it,
the whole history below; tapping a history row moves the editor onto it. A
logged row has no delete button of its own, because a bin beside every row is
destruction a thumb reaches by accident mid-scroll.

## 7. The desktop

**A desktop is not a wider phone.** Three things change and nothing else:

- **Two columns at ≥1000px**, the summary in a STICKY left column.
- **Overlays become dialogs at ≥720px**, with Escape and a backdrop click. The
  backdrop close fires on `mousedown` and only when the press STARTED on the
  scrim, so a drag out of a text selection does not throw away typing.
- **The FAB gives way to header buttons** (Scan, Add food, the Settings gear).
  Both are in the markup and CSS shows exactly one set. `.head-add` and
  `.head-settings` are `display: none` by DEFAULT; on a phone, Settings is the
  link at the foot of the day.

Two traps:

- **Do not move things in the markup to suit the desktop.** `day-foot` lives at
  the END of the document and the desktop grid places it with `grid-area`.
- **Hover belongs behind `@media (hover: hover) and (pointer: fine)`**, or every
  tap on a touchscreen leaves the row lit.

## 8. The deficit, and restaurant menus

### WHOOP: under or over (optional)

`GET /api/whoop` mirrors the Totem bridge into `data/whoop.json`, and only when
the bridge is on. **One token holder**: WHOOP rotates its refresh token and
invalidates the old pair, so the bridge holds it and Krakatoa never does. The
cache is **disposable**, and **nothing blocks on it**.

The design problem is honesty. `balanceFor` handles it, and the flags are the
feature:

- **`partial`**: today's burn is what WHOOP has counted SO FAR and climbs until
  midnight. A partial day never shows a verdict.
- **`typical`**: the mean burn of COMPLETE days, the only honest thing to read a
  partial number against. Measured, never projected.
- **`untracked`**: a day with nothing logged is not a 2,800 deficit, it is a day
  the app was not opened.

**The refresh button** is the only synchronous path to the bridge. It shows how
stale the number is; **a failed pull keeps the previous numbers** with the
bridge's own error text beside them; with no balance at all, an error still
renders the panel and the button.

**The panel is a tug of war on one track**: eaten from the left, burned from the
right, the meeting point is the reading. The split is **proportional** and
deliberately undramatic. The "even" mark sits **below** the track, because inside
it landed on the join on close days. **An untracked day draws no bar.**
`balance.test.jsx` asserts the SHAPE cannot say what the numbers do not. Server
and client each carry `balanceFor` (CommonJS vs ESM); `whoop.test.js` pins both.

### Restaurants: there is no free source, and that was checked

| tried | result |
|---|---|
| MenuStat (public chain-nutrition dataset) | 403 |
| Open Food Facts, brand `chipotle-mexican-grill` | 0 products |
| USDA Branded | no restaurant chains |
| USDA FNDDS (survey, 5,432 foods) | 7 McDonald's items; no Chipotle, Subway, Taco Bell or Panera |
| Chipotle's nutrition calculator | a JS app, no server-rendered data |

**Nutritionix closed its free tier** (business accounts only). The integration is
kept because it lights up when credentials exist (Settings → Food databases) and
nothing depends on it. It is a separate route from `/api/search` because it costs
a metered call, and detail is fetched on tap and cached under `nix:<id>`. A
search row carries `partial: true`: enough to list, not enough to log.
`configured: null` until probed. **It is the one integration not verified
against a live response**; `nutritionix.test.js` pins the documented shapes.

### Chains read from their own publications

A US chain with 20+ locations must publish nutrition, usually as a PDF, so a
chain gets a menu by pointing `scripts/restaurants.build.mjs` at its own
document. The build does ids, the energy sanity check, cross-checks, and
**refuses to write on a disagreement**.

| chain | reader | source | self-check |
|---|---|---|---|
| Chipotle | `rows-pdf.mjs` | its nutrition PDF | the PDF prints calories a second time on its front page |
| Bibibop | `bbox-pdf.mjs` | its nutrition PDF | the ingredient cards on its website |
| Culver's | `nutritionix-inm.mjs` | the hosted menu file its own nutrition guide loads | refuses a file older than 120 days |
| McDonald's | `mcd-archive.mjs` | its calculator data as the Internet Archive captured it | newest capture of each item wins |
| Panera | `panera-pdf.mjs` | its per-cycle nutrition guide PDF via the Internet Archive | fat printed twice (grams and calories from fat) |
| Balance | `balance-archive.mjs` | its former nutrition page via the Internet Archive | the two city menus must agree |

Worth not undoing:

- **PDFs are read by WORD COORDINATES** (`pdftotext -bbox`), not by line, because
  names wrap above and below their numbers. Each fragment goes to the nearest
  data row WITHIN ITS OWN TABLE; the name/value edge is per table, not per page.
  A name never starts with a closing bracket it did not open (title spill). A
  hyphen at a line break joins; a spaced dash stays punctuation.
- **Columns are placed by POSITION, not count** (Panera): an empty cell otherwise
  slides sugar into fibre.
- **Cross-checks use explicit aliases** (`pageAliases`, `frontAliases`), never a
  fuzzy match, which is how a card gets compared against the wrong item and passes.
- **Raw figures are label-rounded** (`labelRound`, 21 CFR 101.9) to match the
  menu board; PDFs are already rounded.
- **Sites that block scripts are not worked around**; the Archive's public
  copies are read instead, with the capture dates kept and the limits on screen.
  The McDonald's harvest is slow and RESUMABLE (`$TMPDIR/mcd-harvest.json`,
  `MCD_RETRY=1`), and `decode()` tries gzip, brotli and plain.
- **Only McDonald's own `do_not_show: "Core"` items are kept** (`onlyCore`), so
  limited runs from years of captures do not fill the menu.
- **A size counts only where the chain puts one** (`splitSize`, pinned): "Honest
  KIDS Appley Ever After" is a juice box, not a kids' portion.
- **Kids' tables that repeat the main menu are skipped** (`skipFrom`/`resumeAt`),
  and every Chipotle food row must be placed by the `rows` map or the build fails.
- **Panera**: sizes are dash-parts of the name; group/catering, KIDS, GRAB N GO
  and drive-thru duplicates are left out; back-to-front names are turned round
  by per-section `rename` rules BEFORE grouping. A new cycle is a new URL.

A restaurant under 20 locations usually publishes nothing. Nothing is estimated
for one: build its dishes as a combo from the basics, which is honest about
being an estimate.

### The builder

- **A chain is a `bowl` or an `order`.** A bowl is built from parts and named
  from them; an order is picked whole. The size goes AFTER the name.
- **Sizes are portions of ONE item**, with pills under its chip; the selection key
  is `itemId@portionId`. An item opens on the size you would order unasked
  (`defaultPortion`).
- **What a step does is declared on the step** in restaurants.json, never known by
  id in the client: `increment`, `split`, `names`, `extra`, `collapsed`, and a
  portion's `vessel`. **A size scales only the steps it names** (`sizes[].scale`).
- **Every part shows its own kcal and protein** before it is tapped; the total
  sits at the thumb. Components carry the EFFECTIVE quantity.
- **Order menus are searchable**, and menu items are also searched from the main
  search box, brand included.

Adding a chain: pick (or write) a reader, add an entry to `CHAINS`, build just
that chain, and add a test that pins two or three numbers read off its document
by hand.

## 9. The macro pie, and the water

**The ring IS the pie**: how far round it goes is progress to the calorie target;
the colours within the arc are the split.

- **The split is by ENERGY, not grams** (Atwater 4/4/9).
- **Segments are laid out against the MACRO energy, not the logged kcal**, so a
  rounding or alcohol discrepancy is not handed to the three colours.
- **No macros means NO slices**, a plain arc.
- **`stroke-linecap: butt`**: a round cap overhangs its neighbour.

**Water** is `kind: 'water'`, **one entry per day holding a running total**, so
quick buttons are increments and six fast taps are one sync. The quick amounts
are containers, not a slider. 64 oz is the only defaulted target. **The waves are
drawn**, the exception to the icon rule (no library has an animated liquid fill):
a block whose HEIGHT is the level with two sine layers riding its top edge,
stilled under `prefers-reduced-motion`.

## 10. From the label: type it, or photograph it

`labelfood.jsx`: a form laid out like the label, and a **Photograph the label**
button that needs AI.

**The photo only ever FILLS the boxes.** Filled boxes are tinted until edited,
and `checkLabel` says in words when the numbers disagree with themselves
(calories vs 4/4/9, a part bigger than its whole, more grams of macros than the
serving weighs). It never corrects anything.

**The reader is a headless `claude` run** (`server/label.js`). The JPEG goes to
its own temp directory; the run gets `--allowedTools Read`, `--add-dir <that
directory>`, and every write/run/fetch tool denied **by flag**. A prompt is a
request; a flag is a rule. The directory is deleted before the answer returns.
`label.test.js` pins this against a stand-in `claude`.

**Measured:** one read of a blurred label shifted a row (sugar came back as
fibre's "<1g"). Making the model **copy every row out as text first** (`rows` in
the schema) tied each figure to its name. If readings drift, look at `rows`
first.

**Saving keeps it** (`source: 'label'`): starred, and when it came from a missed
barcode, POSTed to `/api/food` and cached under that GTIN for the next scan.

## 11. Ask AI: a receipt, a plate, or words

`ask.jsx`. Ask, working (15–60 s), review. **Nothing is logged until Log.**

**The model never does the arithmetic on a food Krakatoa knows.** `buildIndex()`
writes every food with real numbers (the owner's combos, stars and last 45 days
`yours`, chain menus `menu`, basics `basic`) to `foods.tsv`, one row per portion
with an id. The model answers with ids (or `parts` for a built dish) and
quantities; `resolve()` computes the numbers and ignores any the model offers.
Only unmatched items are `estimate`, shown as "AI estimate", logged
`source: 'ai'`. Pinned in `server/ai.test.js`.

Measured lessons:

- **Another chain's number is not a match.** `proxyOf()` makes a chain row an
  estimate unless the receipt is from that chain, with "based on Chipotle's chips".
- **The owner's own foods are in the PROMPT, not only the table**; left to Grep,
  a place-named combo was found 2 times in 3, shown outright 4 in 4. But the rule
  is "only when it is the same food".
- **A combo row says what one of it holds** in the table, or the model multiplies
  a three-taco combo by three.
- **Medium effort** (default): low found USDA's glazed donut 1 time in 3, medium 3
  in 3.
- **A revision starts from the user's version** (`previousOf`), including the
  model's own estimates, which otherwise drift turn to turn. "Half the chips" is
  qty 0.5 with the same `parts`.

Receipts skip tax/tip/totals into `skipped`. A GROCERY receipt arrives unticked
(bought is not eaten) and offers **Keep as my foods**. Boundary: `Read,Grep` (plus
web search/fetch for chain lookups), a temp `--add-dir`, everything else denied.

### In the background

`POST /api/ask` creates a THREAD (`data/ai/threads/<id>.json`, photo in
`data/ai/photos/`) and answers 202; `makeRunner()` works two at a time; the phone
polls every 2–3 s while working and on `visibilitychange` otherwise. A thread
still "working" at startup is RUN AGAIN (`runner.recover()`). Review edits are
saved as `draft`, tagged with the answer they belong to. Today shows a pill while
one works and when one lands unseen.

### Learning a chain Krakatoa does not know

The run may use `WebSearch`/`WebFetch` to find a chain's OWN nutrition page.
**Nothing from the web is kept on the model's say-so.** `verifyFound()` fetches
the page ITSELF (PDF via pdftotext) and `verifyItem()` keeps an item only when the
page shows its name with that calorie figure among the first few numbers after
it. Unverified items are one-off estimates that say why.

Verified items go to `data/menus/learned.json`, merged by `allRestaurants()`, and
the page is then read IN FULL in the background (`learnRestOfMenu`): a tabular
guide by `tableMenu()`, where Krakatoa reads the rows and the model only maps the
columns (a mapping whose rows disagree with 4/4/9 is thrown away whole); else by
the model in 30 KB chunks, three at a time, every item verified. Use the
**document's own date** (PDF ModDate/CreationDate, else Last-Modified), drop
regional variants, normalise categories, and do not count identical numbers
under another label as a second size.

## 12. Other programs: MCP, and the optional Totem bridge

**MCP.** `server/mcp.js` serves MCP Streamable HTTP (JSON replies) at `POST /mcp`,
with a bearer token unless sign-in is left to a proxy. 16 tools: `get_day`,
`get_history`, `search_foods`, `list_saved`, `log_food`, `ask`, `edit_entry`,
`delete_entry`, `save_food`, `save_combo`, `delete_combo`, `add_water`,
`set_targets`, `lookup_barcode`, `get_menu`, `list_ask_threads`. Names carry no
prefix because gateways namespace them (`krakatoa__log_food`).

- **Refs, not guesses.** Search and saved lists hand back a `ref` per portion
  (`y:` the owner's, `m:` menus, `b:` basics) and `log_food` by ref uses
  KRAKATOA's numbers. No ref means the caller's estimate, `source: 'ai'`. A bad
  ref fails the whole call; nothing half-logs.
- **Same entries, same write path**: every write goes through `commit()` with the
  phone's entry shapes (`via: 'mcp'` is the only difference).
- **`ask` is Ask AI**, waited on, and the thread appears in the app.
- **Every tool states all four hints**; deletes are `destructiveHint` and the
  descriptions say to ask first. Tested in `server/mcp.test.js`.

**The Totem bridge** (off by default; Settings or `KRAKATOA_TOTEM=1`). Two wires:

- **A habit push.** `server/totem.js` posts one record per DAY: calories as
  `value`, the macro split as `parts`, the foods as the note, `count` = foods
  logged. **One day, one record**, rebuilt from the whole day (per-food syncs made
  the last write win). **Fire and forget**: the bridge being down never fails a
  log. **The streak is whether the day was TRACKED**, not whether it was a good
  day, so bad days still get logged. `node server/totem.js --ensure` creates the
  habit once; it is deliberately never called from the request path.
- **WHOOP burn**, read from the bridge (§8).

**The digest file** (off by default): every write regenerates
`data/digest.json`: today's foods, a fortnight of totals, targets, the average
over days logged, about 6 KB. It exists so other tools never read `state.json`,
which grows without limit.

## 13. Things deliberately NOT built

Say so before adding any of them:

- **No automatic logging from a photo.** The label reader and Ask AI produce lists
  to review; nothing is logged without a tap.
- **No weight tracking.** A second body-weight number that disagrees with the
  wearable's is worse than none.
- **No notifications.** A food app nagging is how it gets muted.
- **No multi-user accounts.** One owner per install, by design.
