# LotIQ Bridge

The on-site agent that provisions LotIQ cameras. A super admin drives provisioning from the LotIQ
web portal; the **bridge** is the thing physically on the property's network that carries out the
camera work the portal cannot reach (cameras sit on tenant WiFi behind CGNAT, so nothing in the
cloud can open a connection *to* them).

```
 Super-admin portal ──HTTPS──▶ lotiq-staging-api ◀──outbound polling── Bridge ──LAN──▶ Cameras
   (anywhere)                   /provision-bridge/*                    (this repo)      9000 + HTTP
```

The bridge **pairs** with a 6-digit code the portal shows, then **polls** for jobs, **runs** each
against the cameras on the LAN, and **reports** progress and results. It never holds long-lived
secrets: the backend hands down a fully-rendered job (passwords filled, config steps in order, each
with its read-back expectation) over the short-lived session token, and the bridge just executes and
verifies. Adding a camera setting is a backend change, not an app release.

## Layout

```
lotiq-bridge/
├── app/                  ★ THE PHONE APP — React Native / Expo (matches the main LotIQ Expo app)
│   ├── src/bridge/       Pure-TS bridge core (RN + Node compatible) — typechecked + tested in CI
│   │   ├── crypto.ts         Baichuan crypto (spark-md5 + aes-js) — golden-fixture tested
│   │   ├── frames.ts         Baichuan wire framing — golden-fixture tested
│   │   ├── backendClient.ts  HTTP client for /provision-bridge/* (pair, poll, events, complete)
│   │   ├── jobRunner.ts       run one job: login → password commit → apply+read-back+diff → complete
│   │   ├── cameraDriver.ts    CameraDriver interface + FakeReolink
│   │   ├── baichuanClient.ts  Baichuan TCP client (socket-injected) — ⚠ TCP I/O needs bench validation
│   │   ├── cgi.ts / reolinkDriver.ts  real-camera CGI driver
│   │   └── *.test.ts + __fixtures__/  Node tests (16) + golden vectors
│   ├── App.tsx           the one screen (pair code → live progress)
│   ├── src/rnSocket.ts   react-native-tcp-socket adapter (the only native dependency)
│   └── app.json          Expo config (iOS local-network Info.plist keys)
├── reference/            Node reference bridge — the executable spec, proven end-to-end vs staging
└── dart/                 Dart package — a bench CLI + language-agnostic spec (NOT the phone app)
```

See **[app/README.md](app/README.md)** for building the phone app.

## Why a TS core, a Node reference, and a Dart CLI

The bridge orchestration (pair/poll/run/report) was proven first in the **Node reference**, end-to-end
against the deployed staging backend. The phone app is **React Native**, so its core (`app/src/bridge`)
is a TypeScript port of that proven design, with the Baichuan crypto + framing re-validated
byte-for-byte against the same golden fixtures (`kunal-lotiq/lotiq-installer`'s `bc_fixtures.py`). The
**Dart** package is a byte-identical bench CLI / spec, kept for support work. One design, three
runtimes, each checked against the same fixtures.

## Run the offline demo

```
cd reference
node bin/demo.mjs        # no network: fake backend + fake camera; proves the runner + read-back
```

## End-to-end against deployed staging

The live contract test lives in the backend repo (it needs a super-admin token + AWS creds to set
up and tear down a throwaway property) and drives **this** reference bridge:

```
# in lotiq-backend/
LOTIQ_TABLE_PREFIX=lotiq-staging- AWS_PROFILE=lotiq-staging \
E2E_API=https://etafooe4n9.execute-api.us-east-1.amazonaws.com \
E2E_POOL=us-east-1_3qJ2xy0xg E2E_CLIENT=11m77d67lbodp679tal0kjbg4e \
E2E_USER=claude-test-superadmin@lotiq.test E2E_PASS='...' \
  node scripts/provisioning-e2e.mjs
```

## The phone app (Dart) — status

Not built yet. It ports `reference/lib/*` into a Flutter app whose one screen: pair with a code,
keep the screen awake, poll and run jobs, show per-camera step progress. iOS specifics to carry over
from the installer repo: `NSLocalNetworkUsageDescription` + the local-network permission prompt
(a denied prompt makes discovery silently return zero), ATS `NSAllowsLocalNetworking`, and the
multicast entitlement for UDP discovery (apply early — Apple approval takes time). Ships via
Codemagic → TestFlight, like the installer.

## The backend contract

Everything the bridge calls is under `POST /api/v1/provision-bridge/*`:

| Endpoint | Auth | Purpose |
|---|---|---|
| `/pair` | pairing code | redeem the 6-digit code → session bearer token |
| `/jobs/next` | bearer | claim the next job (or `{job:null}`) — payload has decrypted steps + candidate passwords |
| `/jobs/:id/heartbeat` | bearer | liveness; `{running:true}` moves claimed→running |
| `/jobs/:id/events` | bearer | append progress events (the portal shows these live) |
| `/jobs/:id/password-committed` | bearer | ModifyUser succeeded → backend promotes the pending credential |
| `/jobs/:id/complete` | bearer | report the outcome (`succeeded`/`failed` + read-back diff + device) |

A camera is accepted only when its first footage lands in S3 — the read-back proves settings
applied, but this firmware reports success on settings it ignores, so "green" is footage, not a 200.
