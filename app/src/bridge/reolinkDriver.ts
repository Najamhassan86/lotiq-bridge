/**
 * ReolinkDriver — the real CameraDriver: Baichuan (port 9000) to log in and open the HTTP port, then
 * CGI (port 80) for everything else. Built for a camera whose IP is already known (discovery finds it
 * by UID on the LAN — a separate concern that also needs the native socket).
 *
 * Validation: the crypto + frames it stands on are golden-tested; the end-to-end path against a real
 * camera must be checked on the bench (see baichuanClient.ts).
 */
import { BaichuanClient, type SocketFactory } from './baichuanClient.ts';
import type { CameraDriver } from './cameraDriver.ts';
import { Cgi } from './cgi.ts';

export class ReolinkDriver implements CameraDriver {
  model: string;
  firmware: string;
  private cgi: Cgi | null = null;
  private password = '';

  constructor(
    private readonly ip: string,
    private readonly socketFactory: SocketFactory,
    opts: { model?: string; firmware?: string } = {},
  ) {
    this.model = opts.model ?? '';
    this.firmware = opts.firmware ?? '';
  }

  async login(candidatePasswords: string[]): Promise<string> {
    for (const pw of candidatePasswords) {
      const bc = new BaichuanClient(this.ip, { socketFactory: this.socketFactory, password: pw });
      try {
        await bc.connect();
        await bc.login();
        await bc.setPortEnabled('http', true);
        await bc.close();
      } catch {
        try {
          await bc.close();
        } catch {
          /* ignore */
        }
        continue;
      }
      // HTTP is opening; confirm CGI accepts this password before declaring success.
      const cgi = new Cgi(this.ip, 'admin', pw);
      for (let i = 0; i < 5; i++) {
        if (await cgi.loginWorks()) {
          this.cgi = cgi;
          this.password = pw;
          return pw;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw new Error('no candidate password worked');
  }

  async setAdminPassword(oldPw: string, newPw: string): Promise<void> {
    const cgi = new Cgi(this.ip, 'admin', oldPw);
    await cgi.setAdminPassword(newPw); // ModifyUser old+new, verified by a fresh login
    this.cgi = new Cgi(this.ip, 'admin', newPw);
    this.password = newPw;
  }

  async apply(cmd: string, param: Record<string, unknown>): Promise<void> {
    if (!this.cgi) throw new Error('driver not logged in');
    const r = await this.cgi.call(cmd, param);
    if (r.code !== 0) throw new Error(`${cmd} failed: ${JSON.stringify(r)}`);
  }

  async readBack(verifyCmd: string, verifyParam: Record<string, unknown>): Promise<unknown> {
    if (!this.cgi) throw new Error('driver not logged in');
    const r = await this.cgi.call(verifyCmd, verifyParam, 0);
    return r.value ?? r.initial ?? r;
  }
}
