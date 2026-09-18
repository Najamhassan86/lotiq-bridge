# LotIQ Bridge — field app (React Native / Expo dev build)

The installer's phone app. Sign in → pick a property → see the camera positions a super admin
pre-created → **Set up** a position: scan the Wi-Fi (or type the IP), enter the camera's current admin
password, and the app configures the camera end-to-end over the network — **no Reolink app**.

How a "Set up" runs (`src/autoConfigNative.ts`):

1. **Baichuan** (raw TCP, port 9000): log in, read the UID, and **enable the HTTP port**.
2. **CGI** (HTTP, port 80): push FTP + time (steps rendered by the backend) and read every setting back.
3. Mark the position configured (UID captured automatically). It goes live when its first clip lands.

Because step 1 opens a raw socket, this is a **dev build** (`expo-dev-client`), not Expo Go.

## Layout

| Path | What |
|---|---|
| `src/bridge/` | Pure TS core (Node-testable): `crypto`, `frames`, `cgi`, `baichuanClient`, `reolinkDriver`, read-back diff. |
| `src/autoConfigNative.ts` | The full Baichuan→CGI setup flow. |
| `src/discover.ts` | LAN sweep for cameras (port 9000). |
| `src/rnSocket.ts` | The only file that imports the native TCP socket. |
| `src/backend/` | Cognito sign-in + typed installer API client + staging config. |
| `App.tsx` | The UI. |

## Verify without a Mac (works now)

```
cd app
npm install
npm test                                 # 16 core tests (crypto/frames/read-back)
npx tsc -p tsconfig.json --noEmit        # typecheck App.tsx + all modules
npx expo-doctor                          # 21/21 config checks
npx expo export -p ios                   # Metro bundles the iOS JS
```

## Build + run on a device

See **[HANDOFF.md](./HANDOFF.md)** — the Apple-account dev build (EAS cloud, no Mac needed) and the
first real-camera run, step by step.

## What still needs a real camera

The Baichuan crypto and frame *building* are golden-tested, but the raw TCP I/O in
`src/bridge/baichuanClient.ts` (connect, frame reassembly, response decrypt) has never run against real
hardware. The first dev build on a real camera is the bench validation. If Baichuan login fails but the
camera's HTTP port is already on, the app configures it over CGI alone and logs which path opened the port.
