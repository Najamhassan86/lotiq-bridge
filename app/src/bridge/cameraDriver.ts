/**
 * CameraDriver — the small interface the job runner drives, and a FakeReolink for tests. The real
 * ReolinkDriver (Baichuan login + CGI) lives in reolinkDriver.ts and needs the native TCP socket.
 */
export interface CameraDriver {
  readonly model: string;
  readonly firmware: string;
  login(candidatePasswords: string[]): Promise<string>;
  setAdminPassword(oldPw: string, newPw: string): Promise<void>;
  apply(cmd: string, param: Record<string, unknown>): Promise<void>;
  readBack(verifyCmd: string, verifyParam: Record<string, unknown>): Promise<unknown>;
}

/**
 * A Reolink stand-in for tests and the app's "simulate camera" mode: blank password on a factory
 * unit, ModifyUser needing old+new (a bare `password` is ignored — trap 4), and user/password
 * fields masked on read. Stores whatever is applied and returns it under the matching Get key.
 */
export class FakeReolink implements CameraDriver {
  readonly uid: string;
  readonly model: string;
  readonly firmware: string;
  password: string;
  loginAttempts = 0;
  locked = false;
  private readonly store: Record<string, unknown> = {};
  /** Model the "SetFtpV20 saves but mode stays 0" silent-failure trap so a test can catch it. */
  readonly ignoreFtpMode: boolean;

  constructor(opts: {
    uid: string;
    model?: string;
    firmware?: string;
    password?: string;
    ignoreFtpMode?: boolean;
  }) {
    this.uid = opts.uid;
    this.model = opts.model ?? 'RLC-1224A';
    this.firmware = opts.firmware ?? 'v3.2.0.5170_2510296888';
    this.password = opts.password ?? '';
    this.ignoreFtpMode = opts.ignoreFtpMode ?? false;
  }

  private verifyKeyFor(cmd: string): string {
    return cmd.startsWith('Set') ? `Get${cmd.slice(3)}` : cmd;
  }

  async login(candidatePasswords: string[]): Promise<string> {
    for (const pw of candidatePasswords) {
      if (this.locked) throw new Error('camera locked (too many failed logins)');
      this.loginAttempts += 1;
      if (pw === this.password) return pw;
      if (this.loginAttempts >= 10) this.locked = true;
    }
    throw new Error('no candidate password worked');
  }

  async setAdminPassword(oldPw: string, newPw: string): Promise<void> {
    if (oldPw !== this.password) throw new Error('ModifyUser: oldPassword does not match');
    if (!newPw || newPw.length < 6) throw new Error('ModifyUser: newPassword rejected');
    this.password = newPw;
  }

  async apply(cmd: string, param: Record<string, unknown>): Promise<void> {
    const key = this.verifyKeyFor(cmd);
    const stored = JSON.parse(JSON.stringify(param ?? {})) as Record<string, unknown>;
    if (cmd === 'SetFtpV20' && this.ignoreFtpMode && stored.Ftp && typeof stored.Ftp === 'object') {
      (stored.Ftp as Record<string, unknown>).mode = 0; // the trap
    }
    this.store[key] = stored;
  }

  async readBack(verifyCmd: string): Promise<unknown> {
    const raw = this.store[verifyCmd];
    if (raw === undefined) return {};
    const v = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    for (const block of ['Ftp', 'Email']) {
      const b = v[block];
      if (b && typeof b === 'object') {
        const m = b as Record<string, unknown>;
        if (typeof m.userName === 'string') m.userName = maskMiddle(m.userName);
        if (typeof m.password === 'string') {
          const n = Math.min(64, Math.max(4, m.password.length));
          m.password = '*'.repeat(n);
        }
      }
    }
    return v;
  }
}

function maskMiddle(s: string): string {
  if (s.length <= 2) return s;
  return s[0] + '*'.repeat(s.length - 2) + s[s.length - 1];
}
