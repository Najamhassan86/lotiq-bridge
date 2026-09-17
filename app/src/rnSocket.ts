/**
 * React Native socket adapter for the Baichuan client — the ONE place the native TCP dependency
 * lives, kept out of the pure core so the core stays Node-testable.
 *
 * Backed by `react-native-tcp-socket`. Install + native setup:
 *   npx expo install react-native-tcp-socket
 *   (bare/prebuild workflow — this is a native module; `npx expo prebuild` then a dev build.)
 *
 * NOT imported by any test — it only runs on device. `import TcpSocket from 'react-native-tcp-socket'`
 * resolves once the dependency is installed during app scaffolding.
 */
// @ts-expect-error — resolved after `expo install react-native-tcp-socket`
import TcpSocket from 'react-native-tcp-socket';
import type { BaichuanSocket } from './bridge/baichuanClient.ts';

/** A BaichuanSocket over react-native-tcp-socket, buffering inbound chunks for the frame reader. */
class RnBaichuanSocket implements BaichuanSocket {
  private socket: unknown = null;
  private readonly queue: Uint8Array[] = [];
  private waiters: Array<(v: Uint8Array | null) => void> = [];
  private closed = false;

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = TcpSocket.createConnection({ host, port }, () => resolve());
      s.on('data', (data: ArrayBuffer | Uint8Array | string) => {
        const bytes =
          typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data instanceof Uint8Array
              ? data
              : new Uint8Array(data);
        const w = this.waiters.shift();
        if (w) w(bytes);
        else this.queue.push(bytes);
      });
      s.on('error', (e: Error) => reject(e));
      s.on('close', () => {
        this.closed = true;
        this.waiters.forEach((w) => w(null));
        this.waiters = [];
      });
      this.socket = s;
    });
  }

  write(data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.socket as any).write(Buffer.from(data), undefined, (e?: Error) => (e ? reject(e) : resolve()));
    });
  }

  read(timeoutMs: number): Promise<Uint8Array | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onData);
        resolve(new Uint8Array(0));
      }, timeoutMs);
      const onData = (v: Uint8Array | null) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.waiters.push(onData);
    });
  }

  close(): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.socket as any)?.destroy();
    } catch {
      /* ignore */
    }
    return Promise.resolve();
  }
}

export const rnSocketFactory = (): BaichuanSocket => new RnBaichuanSocket();
