# LotIQ Bridge — field app (React Native / Expo)

The phone app. Pairs with the portal (6-digit code), polls the backend for provisioning jobs, and
runs them against cameras on the local network. All logic is in `src/bridge` (pure TypeScript,
type-checked + tested in CI); `App.tsx` and `src/rnSocket.ts` are the RN/native layer.

## What's validated vs. what needs the toolchain

| Part | Status |
|---|---|
| `src/bridge/crypto.ts` — Baichuan crypto | ✅ golden fixtures (`npm test`) |
| `src/bridge/frames.ts` — wire framing | ✅ golden fixtures |
| `src/bridge/{readback,jobRunner,backendClient,bridge,cameraDriver}.ts` | ✅ ported from the staging-proven Node reference; unit-tested |
| `src/bridge/{baichuanClient,cgi,reolinkDriver}.ts` — real-camera driver | ⚠️ typechecked; **TCP I/O needs bench validation against a real camera** |
| `App.tsx`, `src/rnSocket.ts` — RN UI + native socket | ⚠️ needs Expo toolchain to build; **not yet run** |

## Test the core (no toolchain, works now)

```
cd app
npm install
npm test          # node --test — crypto/frames/readback/jobRunner (16 tests)
npx tsc --noEmit  # typecheck the core
```

## Build the app (needs Node + the Expo CLI; iOS needs a Mac or Codemagic)

The Baichuan protocol needs raw TCP sockets, which is a **native module** — so this is a
prebuild/dev-build app, **not** Expo Go.

```
cd app
# 1. Add the Expo + RN + native deps (regenerates package-lock with them):
npx create-expo-app@latest . --template blank-typescript   # ONLY if scaffolding fresh — see note
npx expo install react-native-tcp-socket expo-keep-awake
# 2. Generate native projects (reads app.json → Info.plist local-network keys):
npx expo prebuild
# 3a. iOS dev build on a Mac:
npx expo run:ios
# 3b. or via EAS / Codemagic for TestFlight (no Mac needed) — see below.
```

> Note: this repo already has `App.tsx`, `app.json`, `src/`, `package.json`. Don't overwrite them —
> run `expo install` for the deps and `expo prebuild` for the native projects; only use
> `create-expo-app` if you are starting the scaffold from nothing and then copy `src/` + `App.tsx` in.

## First TestFlight build: "Simulate camera" ON

The app defaults to **Simulate camera**, which runs jobs against an in-memory `FakeReolink`. That
exercises the whole phone → backend path (pair, poll, run, report) with **no real camera on the
LAN** — the right first build to confirm on your iPhone. Turn it off once the real driver is
bench-validated.

## iOS specifics

- `app.json` sets `NSLocalNetworkUsageDescription` + `NSAllowsLocalNetworking`. iOS 14+ prompts for
  local-network access on the first socket connect; if the installer taps Deny, discovery silently
  finds nothing — tell them to tap Allow.
- Apply for Apple's **multicast entitlement** early if you later add UDP discovery (approval takes
  time). The current path is a TCP sweep, which needs no entitlement.

## TestFlight via Codemagic

Add an `ios-testflight` workflow to the repo-root `codemagic.yaml`, modelled on
`kunal-lotiq/lotiq-installer`: App Store Connect API key (Team integrations), distribution cert + App
Store profile, `xcode-project use-profiles`, `expo prebuild`, `pod install`, `xcode-project
build-ipa`, then publish to the `LotIQ Internal` TestFlight group. Add tester `najamhassan202@gmail.com`.
