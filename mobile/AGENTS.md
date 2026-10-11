# AGENTS.md — Krakatoa for iPhone

The native client for the Krakatoa server. It recreates the web app's **phone** layout
(`../app/src`, served by `../server/server.js`) one to one, and uses native mechanics where a
phone has them: overlays are page sheets, the add flow is a native stack inside its sheet (push and
swipe back), the camera reads barcodes natively, confirms and "⋯" are system sheets, some lists
swipe, the day swipes between days and pulls to sync, and logging, scanning and toggles give haptics.

It is modelled on Totem's app (`mobile/` in the Totem repo): same layout, tooling and conventions.

## Expo has changed — do not trust memory

This is Expo SDK 57 (React Native 0.86, expo-router). Before touching an Expo API, read the versioned docs:
append `.md` to any docs.expo.dev URL, starting from https://docs.expo.dev/llms.txt.
Use `npx expo install <pkg>` for dependencies so versions match the SDK.

## How it fits together

- `src/lib/` holds the web's logic, ported nearly verbatim at the **same names** as `app/src/lib/`:
  `food.ts`, `macros.ts`, `combos.ts`, `basics.ts`, `restaurants.ts`, `label.ts`, `ask.ts`,
  `askapi.ts`, `whoop.ts`, `server.ts`, `photo.ts`, `signout.ts`, `store.ts`. Each says "Ported from
  app/src/lib/…". When the web changes one of these, port the change the same way. Only fix what React
  Native needs (no `window`, `document`, `navigator`, canvas or `<input type=file>`).
- `store.ts` is the web's `useStore`, but ONE shared store instead of a hook's state: the day, the add
  sheet and the food sheet are separate screens, so they subscribe to the same module. Writers, readers
  and the merge rule are the web's, line for line. `startSync()` (mounted by the root layout once
  signed in) pulls on open, on return to the foreground and every minute, and retries a pending push
  on the same beats (there is no `online` event).
- `localStorage` is real: `src/lib/boot.ts` installs expo-sqlite's synchronous localStorage before
  anything else loads, so the log (`krakatoa.state.v1`), the basics and the chain menus persist and
  work offline. Sign-out clears every `krakatoa.*` key but the server address.
- `src/lib/connection.ts` holds the server's base URL and the session. Every request goes through
  `apiFetch` (the web's `fetch('/api/…')`) or `imageSource` (for expo-image). It never uses the
  cookie jar. A 401 from `/api` forgets the session and returns to Connect, as the web's
  `installAuthRedirect` sends a browser to `/login`.
- `src/theme.ts` holds the web's CSS variables (`--panel-2` → `colors.panel2`). `src/ui/` holds the
  building blocks: `T` (text), `kit.tsx` (the web's `.btn`, `.icon-btn`, `.link`, `.chip`, `.seg`,
  `.text-input`, `.field`, `.panel`, `.big-action`, `.search-box`, `.stepper`, `.macro-readout` …),
  `Pane.tsx` (`.pane`: head, scrolling body, a foot that rides the keyboard), `Thumb.tsx`, `menu.ts`
  (system menus and confirms), `haptics.ts`, `ToastHost.tsx`.
- `src/app/` holds routes only. `index` is the day; `add/` is the add sheet's stack; `food`, `targets`
  and `settings` are page sheets; `connect` is first run. Presentations are declared in
  `src/app/_layout.tsx`, on the navigator.
- `src/features/<area>/` holds the screens: `today/` (the day, water, targets), `add/` (every view of
  the web's AddFlow, the camera, the combo and bowl builders, the label form), `ask/`, `food/`,
  `settings/`. `features/add/flow.ts` is what AddFlow kept in `useState` (mode, the combo being built,
  the food picked, the barcode that missed), shared by the add sheet's screens.

## Signing in

The server signs a browser in with a cookie. The app signs in with the same username and password
(`POST /api/auth/login` with `X-Krakatoa-Client: native`), gets the session in the reply instead of a
cookie, keeps it in the keychain (expo-secure-store) and sends it as `X-Krakatoa-Session`. To the
server it is the same session: same signature and version check, Settings may be changed with it, and
signing out or changing the password ends it. Changing the password on the phone hands it the next
session in the reply. A server with `KRAKATOA_AUTH=proxy` asks for nothing, and one behind Cloudflare
Access is signed into first (`cfAccess.ts`, the same as Totem's app).

## Rules

- **The web is the spec.** Same sections, copy, order, colours and states as the web's phone layout. A
  difference must be deliberate and native (a sheet, a swipe, a system menu, a haptic), not drift.
- **Never hand-draw an icon.** The web's lucide icons come from lucide-react-native, imported per icon
  (`lucide-react-native/icons/<name>`, the package's own subpath) under the web's names in
  `src/lib/icons.ts`. Add one there; confirm the file exists in `node_modules` first. The water's two
  sine waves are the one drawn shape, as on the web (AGENTS.md §9): a liquid fill, not a glyph.
- **The app has no API of its own.** Keep it aligned with `server/server.js`. The one server change it
  needed is the session header above (`server/auth.js`); test any other in `server/install.test.js`.
- **A component never holds a COPY of an entry**, the web's rule: derive it from the store every render.
- **This directory is published with the rest of Krakatoa.** No hosts, IPs, names, emails or accounts
  in tracked files; the install's identity lives in the gitignored `app.local.json`.

## Running, building, shipping

```sh
cd mobile && npm install                           # its own install; app.local.json first (README)
npx tsc --noEmit                                   # typecheck
npx expo export --platform ios --output-dir /tmp/x # proves the JS bundles
npm run start:tailscale                            # Metro on the Tailscale IP, for the dev client
```

- **Dev client:** `npx eas-cli build -p ios --profile development`, install it on the phone, then
  `npm run start:tailscale`. Rebuild it whenever a native module is added or `app.json` plugins change.
  Expo Go cannot run this app (the camera's scanner, keyboard-controller and the rest need the dev client).
- **TestFlight:** `npx eas-cli build -p ios --profile production --auto-submit` (build number auto-increments).
- **Over-the-air:** `npx eas-cli update --channel production -m "…"` ships JS-only changes to installed
  TestFlight builds. `runtimeVersion` uses the fingerprint policy, so an update only reaches binaries
  whose native code matches. If native code changed, build again instead.

## Gotchas

- iOS ATS allows plain http (`NSAllowsArbitraryLoads`) because the server is usually reached over
  Tailscale at `http://<100.x>:8101`. The camera does not need https here, unlike the web's.
- `expo/fetch` is the global fetch on SDK 57; requests pass `credentials: 'omit'` so no cookie is ever
  stored or sent beside the keychain's session.
- A sheet opened from another sheet waits for the first to close (`setTimeout(…, 350)` in the food
  sheet's "Log it again" and the camera's hand-offs): presenting while one is dismissing is dropped.
- **The install's identity is not in the repo.** The bundle id and the EAS project id live in the gitignored
  `app.local.json`, which `app.config.js` merges into `app.json`. The repo-root `.easignore` uploads only
  `mobile/` to EAS, including that file.
- `eas.json` is part of the runtime fingerprint. Change it only alongside a new build, or later
  `eas update`s target a runtime the installed build does not have. `eas update` needs `--environment production`.
- Every screen sits under an error boundary (`src/shell/ScreenError.tsx`), so a server whose data changed
  shape shows an error on that screen instead of closing the app.
