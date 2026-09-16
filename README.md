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
├── reference/            Node reference bridge — the executable spec (dependency-free, testable now)
│   ├── lib/
│   │   ├── backendClient.mjs   HTTP client for /provision-bridge/* (pair, poll, events, complete)
│   │   ├── cameraDriver.mjs    the CameraDriver interface + FakeReolink for tests
│   │   ├── jobRunner.mjs       run one job: login → set password (two-step commit) → apply+verify
│   │   ├── bridge.mjs          the pair-then-poll loop
│   │   └── masking.mjs         read-back diff (matches the backend's, wildcard '*' + field masking)
│   └── bin/demo.mjs            offline demo (fake backend + fake camera)
└── dart/                 Dart/Flutter bridge for iOS (the phone app) — ports reference/ 1:1
```

## Why a Node reference *and* a Dart app

The protocol crypto (Baichuan, `md5_modern`, AES-CFB128) is already byte-validated in
`kunal-lotiq/lotiq-installer`'s Dart core against golden fixtures. What's new here is the **bridge
orchestration** (pair/poll/run/report) — plain HTTP plus the existing CGI calls. This project proves
that orchestration in Node against the live backend first (see the e2e below), then the Dart app
mirrors `reference/lib/*` call-for-call so the phone build is a port of a proven design, not a
rewrite. The same pattern the installer repo already uses (Python reference → Dart port).

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
