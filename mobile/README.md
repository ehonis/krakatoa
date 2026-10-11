# Krakatoa for iPhone

The native app for [Krakatoa](../README.md), a self-hosted food log. It is the web app's phone layout
rebuilt in React Native (Expo SDK 57): the same day, the same ways to add food, with page sheets, a
native barcode scanner, system menus, swipes and haptics.

## Run

Copy `app.local.example.json` to `app.local.json` and fill in your own bundle id and EAS project id
(`npx eas-cli init` creates a project). It is gitignored; `app.config.js` reads it.

```bash
cd mobile
npm install
npm run start:tailscale   # Metro on this machine's Tailscale IP
```

Open it in a Krakatoa development build (Expo Go cannot load its native modules). On first launch, enter:

- **Server**: the machine running Krakatoa, e.g. `100.64.0.10` (port 8101 is assumed) or `https://food.example.com`
- **Username and password**: the owner account created at `/setup`. A server running with
  `KRAKATOA_AUTH=proxy` needs neither.

The session is stored in the iOS keychain. The server must include the native sign-in (any Krakatoa
from the commit that added this app onwards).

## Build

```bash
npx eas-cli build -p ios --profile development              # dev client
npx eas-cli build -p ios --profile production --auto-submit # TestFlight
npx eas-cli update --channel production -m "message"        # JS-only update to installed builds
```

See `AGENTS.md` for how the code is laid out and the rules for changing it.
