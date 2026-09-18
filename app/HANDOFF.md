# LotIQ Bridge — Apple-account dev build handoff

This app is **complete and builds**. It is no longer an Expo Go app — it opens a raw TCP socket to the
camera (Baichuan, port 9000) to enable the HTTP port and read the UID, then configures FTP + time over
CGI. Raw sockets are a native module, so it must be built as a **dev build** (`expo-dev-client`) with an
Apple account. Nothing in the code needs to change to build it; this doc is the build-and-run recipe.

What it already does (verified here, on Windows, no Mac):

- `npm test` → 16/16 core tests pass (Baichuan crypto/frames, read-back diff).
- `npx tsc -p tsconfig.json --noEmit` → 0 errors (App.tsx + all modules).
- `npx expo-doctor` → 21/21 checks pass.
- `npx expo export -p ios` → Metro bundles cleanly (614 modules).

The one thing that can only be done on an Apple account is the actual iOS build + install on a device —
that's this doc.

---

## Recommended: EAS cloud build (no Mac needed)

EAS builds the iOS `.ipa` in Apple's cloud, so you do **not** need a Mac. You need:

- An **Apple Developer Program** membership ($99/yr) on the team's Apple ID (required for installing on a
  physical iPhone via internal/ad-hoc distribution).
- The **UDID** of each test iPhone (registered below).
- An Expo account with access to the `sova-vis-team` org (the project id is already in `app.json`:
  `4a3b4618-4ef3-45f8-b8e8-2e9b155e63a9`). If you use a different Expo org, run `eas init` to re-point it.

### Steps

```bash
cd app
npm install                      # restore deps (package-lock is committed)

npm i -g eas-cli                 # or: npx eas-cli@latest ...
eas login                        # your Expo account

# 1. Register the test iPhone(s). This opens a link to install a provisioning profile on the phone,
#    OR you paste the UDID. Do this once per device.
eas device:create

# 2. Build the dev client for iOS. EAS will ask to log in to Apple and will generate the signing
#    certificate + provisioning profile for you (choose "let EAS handle it").
eas build --profile development --platform ios
```

- When EAS asks for Apple credentials, give the **Apple ID + an app-specific password** (create one at
  appleid.apple.com → Sign-In & Security → App-Specific Passwords). Do **not** paste the main Apple
  password or a 2FA code into any third-party prompt. Alternatively, set up an **App Store Connect API
  key** (App Store Connect → Users and Access → Integrations → Keys) and give EAS the key — this is the
  cleaner long-term option and avoids Apple passwords entirely.
- The `development` profile (`eas.json`) is `developmentClient: true`, `distribution: internal` — it
  produces an installable dev build for registered devices, not a store submission.

### Install + run

1. When the build finishes, EAS shows a QR code / URL. Open it on the **registered** iPhone and install
   the "LotIQ Bridge (dev)" app.
2. On your computer, start the JS bundler:
   ```bash
   cd app
   npx expo start --dev-client
   ```
3. Open the installed app on the phone and connect it to the bundler (scan the QR from `expo start`, or
   it auto-connects on the same network). The JS loads from your machine; native code is baked into the
   dev build, so you can iterate on `App.tsx` / `src/*` without rebuilding — only a **native** change
   (new native module, `app.json` iOS keys) needs a new `eas build`.

---

## Alternative: local build on a Mac

```bash
cd app
npm install
npx expo prebuild -p ios         # generates ./ios from app.json (Info.plist local-network keys, etc.)
npx expo run:ios --device        # build + install onto a plugged-in iPhone (needs Xcode + your Apple team)
```

`expo run:ios` uses your Xcode signing (Xcode → Settings → Accounts → your Apple ID → the team). For a
physical device the bundle id `pro.lotiq.bridge` must be registered to that team (Xcode does this
automatically the first time).

---

## First real-camera run (what the installer does)

1. Be on the **same Wi-Fi** as the camera (a running, initialized Reolink whose admin password you know).
2. Open the app → **Sign in** with the installer's LotIQ (Cognito) email + password.
3. Pick the **property**, then **Continue to positions**. Positions are the camera slots a super admin
   pre-created on the portal (each carries the FTP host + config profile).
4. Tap **Set up** on a position → in the sheet:
   - Tap **Scan Wi-Fi** to find cameras (or type the camera's IP).
   - Enter the camera's **current admin password**. Optionally set a **new** password to rotate to.
   - Tap **Configure automatically**.
5. The app: logs in over Baichuan → **opens the HTTP port** → reads the UID → pushes FTP + time over CGI
   → reads every setting back. On success it marks the position configured (UID saved automatically). No
   Reolink app is used at any point.
6. The position goes to *awaiting footage* and flips to **live** on the portal when its first clip lands.

**iOS local-network prompt:** the first time the app touches the LAN, iOS asks for local-network access.
Tap **Allow** — if denied, the scan finds nothing and connections fail silently. (`app.json` already sets
`NSLocalNetworkUsageDescription` and ATS `NSAllowsLocalNetworking` for cleartext HTTP to the camera IP.)

---

## Notes for whoever maintains this

- **New Architecture is disabled** (`app.json` → `expo-build-properties` → `newArchEnabled: false`) because
  `react-native-tcp-socket` is untested on it. Keep it off until that library ships a Fabric/TurboModule
  build; the `expo-doctor` exclusion in `package.json` documents this.
- **Backend/target** is staging, baked into `src/backend/config.ts`
  (`https://etafooe4n9.execute-api.us-east-1.amazonaws.com`, Cognito client `11m77d67lbodp679tal0kjbg4e`).
  Point at production by changing that one file.
- **Bench-validate the Baichuan I/O** on the first real camera. The crypto and frame *building* are golden-
  tested, but the TCP connect / frame reassembly / response decrypt (`src/bridge/baichuanClient.ts`) has
  never run against real hardware — this build is the first chance to confirm it. If Baichuan login fails
  but the camera's HTTP port is already on, the app still configures it over CGI alone (it degrades
  gracefully and logs which path opened the port).
- **Where the logic is:** `src/bridge/` is pure TS (Node-testable) — crypto, frames, CGI client, Baichuan
  client, read-back diff. `src/autoConfigNative.ts` orchestrates the full flow. `src/discover.ts` is the
  LAN sweep. `src/rnSocket.ts` is the only file that imports the native socket. `App.tsx` is the UI.
