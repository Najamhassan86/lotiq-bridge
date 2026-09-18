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
import { loginFrame, nonceFrame, aesCommandFrame } from './frames.ts';

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

  /**
   * Read one full frame off the stream and return its header + body. The header length is decided by
   * the message class at bytes 18–19 (bc_prove `_recv_frame`): class 1466 → 20-byte header (the nonce
   * reply), everything else (1464 / 0000) → 24-byte. For a 24-byte frame, bytes 16–17 carry the status.
   *
   * Reading these class bytes big-endian is the fix for the "timeout reading Baichuan frame" bug: the
   * old code compared them little-endian, never matched 1466, always assumed a 24-byte header, and so
   * waited forever for 4 bytes past the end of a 20-byte nonce reply.
   */
  private async readFrame(timeoutMs = 10000): Promise<{ cmdId: number; headerLen: number; header: Uint8Array; body: Uint8Array }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.buf.length >= 4 && this.rdU32(0) !== MAGIC) throw new Error('Baichuan framing lost (bad magic)');
      if (this.buf.length >= 20) {
        const cmdId = this.rdU32(4);
        const lenBody = this.rdU32(8);
        const cls = (this.buf[18] << 8) | this.buf[19]; // 0x1466 (20-byte) | 0x1464 | 0x0000 (24-byte)
        const headerLen = cls === 0x1466 ? 20 : 24;
        if (this.buf.length >= headerLen + lenBody) {
          if (headerLen === 24) {
            const status = this.buf[16] | (this.buf[17] << 8);
            if (status && status !== 200 && status !== 201 && status !== 300) {
              this.buf = this.buf.slice(headerLen + lenBody);
              throw new Error(status === 401 ? 'Baichuan 401 — wrong camera password' : `Baichuan status ${status}`);
            }
          }
          const header = this.buf.slice(0, headerLen);
          const body = this.buf.slice(headerLen, headerLen + lenBody);
          this.buf = this.buf.slice(headerLen + lenBody);
          return { cmdId, headerLen, header, body };
        }
      }
      if (Date.now() > deadline) throw new Error('timeout reading Baichuan frame');
      const chunk = await this.sock.read(Math.max(1, deadline - Date.now()));
      if (chunk == null) throw new Error('socket closed while reading frame');
      if (chunk.length) this.append(chunk);
    }
  }

  /** Read frames until one matches `wantCmd`, skipping the camera's unsolicited push frames. */
  private async readFrameForCmd(wantCmd: number): Promise<{ cmdId: number; headerLen: number; header: Uint8Array; body: Uint8Array }> {
    for (;;) {
      const f = await this.readFrame();
      if (f.cmdId === wantCmd) return f;
    }
  }

  /** Decrypt a frame body per bc_prove `_decrypt`: BC-XOR for the 20-byte reply, plaintext, or AES. */
  private decryptFrame(header: Uint8Array, headerLen: number, body: Uint8Array): string {
    if (!body.length) return '';
    const encOffset = header[12];
    const encType = (header[16] << 8) | header[17];
    const dec = new TextDecoder();
    let out: string;
    if (headerLen === 20 && (encType === 0x01dd || encType === 0x12dd)) out = dec.decode(bcXor(body, encOffset));
    else if (encType === 0x00dd) out = dec.decode(body);
    else out = dec.decode(this.aesKey ? aesDecrypt(this.aesKey, body) : body);
    // Fallback: if it didn't decode to XML, try BC-XOR (matches the reference's belt-and-braces).
    if (!out.startsWith('<?xml')) {
      const alt = dec.decode(bcXor(body, encOffset));
      if (alt.startsWith('<?xml')) return alt;
    }
    return out;
  }

  /** Nonce handshake: send the class-1465 request, decrypt the reply. */
  async getNonce(): Promise<string> {
    await this.sock.write(nonceFrame(this.nextMessId()));
    const f = await this.readFrameForCmd(1);
    const xml = this.decryptFrame(f.header, f.headerLen, f.body);
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
      `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n` +
      `<LoginUser version="1.1">\n<userName>${userHash}</userName>\n<password>${passHash}</password>\n<userVer>1</userVer>\n</LoginUser>\n` +
      `<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n</body>\n`;
    await this.sock.write(loginFrame(xml, this.nextMessId()));
    const f = await this.readFrameForCmd(1);
    const reply = this.decryptFrame(f.header, f.headerLen, f.body);
    if (!/<code>0<\/code>|<rspCode>200<\/rspCode>|LoginUser/i.test(reply)) {
      throw new Error(`login rejected: ${reply.slice(0, 160)}`);
    }
  }

  private async sendAes(cmdId: number, xml: string): Promise<string> {
    if (!this.aesKey) throw new Error('not logged in');
    await this.sock.write(aesCommandFrame(cmdId, xml, this.aesKey, this.nextMessId()));
    const f = await this.readFrameForCmd(cmdId);
    return this.decryptFrame(f.header, f.headerLen, f.body);
  }

  /** cmd 114 — the stable device UID (best-effort). */
  async getUid(): Promise<string | null> {
    const reply = await this.sendAes(114, `<?xml version="1.0" encoding="UTF-8" ?>\n<body></body>\n`);
    const m = reply.match(/<uid>([^<]+)<\/uid>/);
    return m ? m[1] : null;
  }

  /**
   * cmd 36 — enable a service port so the CGI API becomes reachable. Body matches bc_prove `set_port`:
   * `<HttpPort version="1.1"><enable>1</enable></HttpPort>` (NOT the old `<PortInfo><httpEnable>` form,
   * which the camera silently ignored).
   */
  async setPortEnabled(name: string, enable: boolean): Promise<void> {
    const tag = name.charAt(0).toUpperCase() + name.slice(1) + 'Port';
    const xml =
      `<?xml version="1.0" encoding="UTF-8" ?>\n<body><${tag} version="1.1"><enable>${enable ? 1 : 0}</enable></${tag}></body>`;
    await this.sendAes(36, xml);
  }
}
