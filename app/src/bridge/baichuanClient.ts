/**
 * Baichuan TCP client — login on port 9000, read the UID, and open the HTTP port. Ported from the
 * conformance-tested Dart/Python core.
 *
 * ── Validation status ──────────────────────────────────────────────────────────────────────────
 * The crypto (crypto.ts) and the frame BUILDING (frames.ts) are proven byte-for-byte against golden
 * vectors. The TCP I/O below (connect, frame REASSEMBLY off a stream, response decrypt) is a port
 * that must be validated against a real camera on the bench before field use — there is no way to
 * unit-test raw sockets. The reference implementations to diff against are the Dart `BaichuanClient`
 * and the Python `bc_prove.py` in the installer repo.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The socket is injected: React Native supplies one backed by `react-native-tcp-socket`; tests/CLI
 * can supply a Node `net.Socket` adapter. This keeps the native dependency out of the pure core.
 */
import { bcXor, deriveAesKey, md5Modern, aesDecrypt } from './crypto.ts';
import { loginFrame, nonceFrame, aesCommandFrame, HOST_CH_ID } from './frames.ts';

/** Minimal duplex byte stream the client needs. */
export interface BaichuanSocket {
  connect(host: string, port: number): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  /** Resolves with the next chunk of bytes, or null on close. */
  read(timeoutMs: number): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export type SocketFactory = () => BaichuanSocket;

const MAGIC = 0x0abcdef0; // f0 de bc 0a little-endian

export class BaichuanClient {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly sock: BaichuanSocket;
  private buf = new Uint8Array(0);
  private messId = 0;
  private aesKey: Uint8Array | null = null;

  constructor(host: string, opts: { socketFactory: SocketFactory; port?: number; username?: string; password?: string }) {
    this.host = host;
    this.port = opts.port ?? 9000;
    this.username = opts.username ?? 'admin';
    this.password = opts.password ?? '';
    this.sock = opts.socketFactory();
  }

  async connect(timeoutMs = 8000): Promise<void> {
    await this.sock.connect(this.host, this.port);
    void timeoutMs;
  }

  async close(): Promise<void> {
    await this.sock.close();
  }

  private nextMessId(): number {
    this.messId += 1;
    return this.messId;
  }

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  private rdU32(off: number): number {
    return (this.buf[off] | (this.buf[off + 1] << 8) | (this.buf[off + 2] << 16) | (this.buf[off + 3] << 24)) >>> 0;
  }

  /** Read one full frame off the stream: header (20/24 bytes) + body of mess_len. Returns the body. */
  private async readFrame(timeoutMs = 10000): Promise<{ body: Uint8Array; chId: number; isXor: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Need at least the fixed part of the header to know the class + length.
      if (this.buf.length >= 20 && this.rdU32(0) === MAGIC) {
        const messLen = this.rdU32(8);
        const chId = this.buf[12];
        // class marker sits at bytes 16..19; 0x1465 => 20-byte header (nonce/xor), else 24-byte.
        const classHi = this.buf[18] | (this.buf[19] << 8);
        const is1465 = classHi === 0x1465 || classHi === 0x1466;
        const headerLen = is1465 ? 20 : 24;
        if (this.buf.length >= headerLen + messLen) {
          const body = this.buf.slice(headerLen, headerLen + messLen);
          this.buf = this.buf.slice(headerLen + messLen);
          return { body, chId, isXor: is1465 };
        }
      }
      if (Date.now() > deadline) throw new Error('timeout reading Baichuan frame');
      const chunk = await this.sock.read(Math.max(1, deadline - Date.now()));
      if (chunk == null) throw new Error('socket closed while reading frame');
      this.append(chunk);
    }
  }

  /** Nonce handshake: send the class-1465 request, decrypt the reply with BC-XOR at the ch_id offset. */
  async getNonce(): Promise<string> {
    await this.sock.write(nonceFrame(this.nextMessId()));
    const { body, chId } = await this.readFrame();
    const xml = new TextDecoder().decode(bcXor(body, chId || HOST_CH_ID));
    const m = xml.match(/<nonce>([^<]+)<\/nonce>/);
    if (!m) throw new Error('no nonce in response');
    return m[1];
  }

  async login(): Promise<void> {
    const nonce = await this.getNonce();
    const userHash = md5Modern(this.username + nonce);
    const passHash = md5Modern(this.password + nonce);
    this.aesKey = deriveAesKey(nonce, this.password);
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>\n` +
      `<body><LoginUser><userName>${userHash}</userName><password>${passHash}</password>` +
      `<userVer>1</userVer></LoginUser><LoginNet><type>LAN</type><udpPort>0</udpPort></LoginNet></body>\n`;
    await this.sock.write(loginFrame(xml, this.nextMessId()));
    const { body } = await this.readFrame();
    const reply = new TextDecoder().decode(aesDecrypt(this.aesKey, body));
    if (!/<code>0<\/code>|<rspCode>200<\/rspCode>|LoginUser/i.test(reply)) {
      throw new Error(`login rejected: ${reply.slice(0, 160)}`);
    }
  }

  private async sendAes(cmdId: number, xml: string): Promise<string> {
    if (!this.aesKey) throw new Error('not logged in');
    await this.sock.write(aesCommandFrame(cmdId, xml, this.aesKey, this.nextMessId()));
    const { body } = await this.readFrame();
    return new TextDecoder().decode(aesDecrypt(this.aesKey, body));
  }

  /** cmd 114 — the stable device UID. */
  async getUid(): Promise<string | null> {
    const reply = await this.sendAes(114, `<?xml version="1.0" encoding="UTF-8" ?>\n<body></body>\n`);
    const m = reply.match(/<uid>([^<]+)<\/uid>/);
    return m ? m[1] : null;
  }

  /** cmd 36 — enable a service port (e.g. http) so the CGI API becomes reachable. */
  async setPortEnabled(name: string, enable: boolean): Promise<void> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>\n` +
      `<body><PortInfo><${name}Enable>${enable ? 1 : 0}</${name}Enable></PortInfo></body>\n`;
    await this.sendAes(36, xml);
  }
}
