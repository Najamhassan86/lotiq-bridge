/**
 * LAN camera discovery — sweeps the phone's /24 for hosts with the Baichuan port (9000) open, the same
 * TCP-connect scan the proven `bc_provision_batch.py` reference uses. Native-socket only, so it runs
 * in a dev build, not Expo Go. The installer can also skip this and type the IP by hand.
 *
 * We intentionally do NOT log in during the sweep (we don't have per-camera passwords yet) — we just
 * report reachable candidates. The real login + UID read happens when the installer configures one
 * (see autoConfigureNative). The phone's own IP comes from expo-network; both native deps are
 * imported dynamically so this module never crashes a JS-only context.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tcp: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tcp(): Promise<any> {
  if (!_tcp) _tcp = (await import('react-native-tcp-socket')).default;
  return _tcp;
}

/** The device's /24 prefix (e.g. "192.168.1"), or null if it can't be determined. */
export async function localPrefix(): Promise<string | null> {
  try {
    const Network = await import('expo-network');
    const ip = await Network.getIpAddressAsync();
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('0.') && ip !== '127.0.0.1') {
      return ip.split('.').slice(0, 3).join('.');
    }
  } catch {
    /* expo-network absent or permission denied */
  }
  return null;
}

/** Resolves true if a TCP connection to host:port completes within timeoutMs. */
async function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const TcpSocket = await tcp();
  return new Promise<boolean>((resolve) => {
    let done = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sock: any = null;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      sock = TcpSocket.createConnection({ host, port }, () => finish(true));
      sock.on('error', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

export interface ScanOptions {
  /** /24 prefix to sweep, e.g. "192.168.1". Derived from the phone's IP when omitted. */
  prefix?: string;
  port?: number;
  timeoutMs?: number;
  concurrency?: number;
  onFound?: (ip: string) => void;
  log?: (line: string) => void;
}

/** Sweep prefix.1 … prefix.254 for an open Baichuan port; returns the reachable IPs, in order. */
export async function scanForCameras(opts: ScanOptions = {}): Promise<string[]> {
  const { port = 9000, timeoutMs = 700, concurrency = 24, onFound, log } = opts;
  const prefix = opts.prefix ?? (await localPrefix());
  if (!prefix) {
    throw new Error(
      "Couldn't read this phone's Wi-Fi address. Make sure you're on the property's Wi-Fi, or type the camera IP by hand.",
    );
  }
  log?.(`Scanning ${prefix}.0/24 for cameras…`);

  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) hosts.push(`${prefix}.${i}`);

  const found: string[] = [];
  for (let i = 0; i < hosts.length; i += concurrency) {
    const batch = hosts.slice(i, i + concurrency);
    const hits = await Promise.all(batch.map((h) => probe(h, port, timeoutMs).then((ok) => (ok ? h : null))));
    for (const h of hits) {
      if (h) {
        found.push(h);
        onFound?.(h);
      }
    }
  }
  return found;
}
