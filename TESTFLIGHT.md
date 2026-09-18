# LotIQ Bridge → TestFlight

How to build the LotIQ Bridge iOS app and push it to TestFlight. No Mac required — EAS builds in the
cloud. You need an **Apple Developer Program** membership (paid) and an **Expo** account.

The app is complete and builds. It points at the LotIQ **staging** backend (baked into
`app/src/backend/config.ts`) — nothing to configure to get a working TestFlight build.

---

## 1. Clone and install

```bash
git clone https://github.com/Najamhassan86/lotiq-bridge.git
cd lotiq-bridge/app
npm install
```

## 2. Install EAS + log in

```bash
npm i -g eas-cli
eas login              # your Expo account
```

> **Org note:** `app/app.json` sets `owner: "sova-vis-team"` and an EAS `projectId`. If your Expo
> account is **not** a member of that org, either get invited to it, **or** run `eas init` once to
> create/link a project under your own account (it rewrites the `projectId`/`owner`). Either is fine
> for TestFlight.

## 3. Build the release (store) build

```bash
eas build --profile production --platform ios
```

- Use the **`production`** profile — **not** `development`. The dev profile is only for live JS
  reloading over Wi‑Fi; TestFlight bakes the JS into the app so testers just open it.
- When prompted for Apple credentials, give your **Apple ID + an app-specific password** (create one
  at appleid.apple.com → Sign‑In & Security → App‑Specific Passwords), **or** an **App Store Connect
  API key** (cleaner, no Apple password). Let EAS generate the signing cert + provisioning profile and
  create the App Store Connect app for bundle id `pro.lotiq.bridge`.

## 4. Submit to TestFlight

```bash
eas submit --profile production --platform ios
```

- Pick the build you just made. It uploads to App Store Connect; TestFlight processing takes ~5–15 min.

## 5. Add testers (App Store Connect → TestFlight)

- **Internal testers** (up to 100, on your team) can install immediately.
- **External testers** need a short Apple review of the first build, then install via the **TestFlight**
  app on their iPhone.
- Export compliance is already answered in `app.json` (`ITSAppUsesNonExemptEncryption: false`), so
  there's no crypto questionnaire.

---

## Things to know

- **To actually test provisioning**, the tester's iPhone must be on the **same Wi‑Fi as a real Reolink
  camera** (a running, initialized camera whose admin password you know). On first LAN access iOS
  prompts for local‑network permission — tap **Allow**.
- **New Architecture is disabled on purpose** (`app.json` → `expo-build-properties` →
  `newArchEnabled: false`) because `react-native-tcp-socket` (the raw socket the camera setup needs) is
  untested on it. Leave it off.
- **Unproven on hardware:** the Baichuan TCP path (open the camera's HTTP port + login) has never run
  against a real camera. This build is the first chance to confirm it. If the camera's HTTP port is
  already on, the app configures it over CGI alone and logs which path opened the port.
- **Backend/target** is staging, in `app/src/backend/config.ts`. Change that one file to point elsewhere.
- The in‑app flow and a deeper dive (including the alternative internal dev‑client build for fast JS
  iteration) are in **`app/HANDOFF.md`** and **`app/README.md`**.

## Quick sanity checks before building (optional, run in `app/`)

```bash
npm test                              # 16 core tests
npx tsc -p tsconfig.json --noEmit     # typecheck
npx expo-doctor                       # 21/21 config checks
```
