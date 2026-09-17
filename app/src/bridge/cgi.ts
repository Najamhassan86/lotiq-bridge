/**
 * Reolink CGI (HTTP) client. TS port of the vendored Dart `Cgi`. Once Baichuan has opened port 80,
 * everything else is CGI. Uses fetch (RN + Node).
 *
 * TRAP 5: build the query string by hand — an empty `password` value must still appear as
 * `password=`; some URL builders drop the bare `=` and the camera then rejects the request with an
 * auth failure identical to a wrong password. The CGI API also returns two envelope shapes for the
 * same command; `unwrap` handles both.
 */
export interface CgiResult {
  cmd?: string;
  code?: number;
  value?: Record<string, unknown>;
  initial?: Record<string, unknown>;
  [k: string]: unknown;
}

export class Cgi {
  constructor(
    private readonly ip: string,
    private readonly username = 'admin',
    private password = '',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(cmd: string): string {
    const qs =
      `cmd=${encodeURIComponent(cmd)}` +
      `&user=${encodeURIComponent(this.username)}` +
      `&password=${encodeURIComponent(this.password)}`;
    return `http://${this.ip}/cgi-bin/api.cgi?${qs}`;
  }

  async call(cmd: string, param: Record<string, unknown>, action = 0): Promise<CgiResult> {
    const res = await this.fetchImpl(this.url(cmd), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ cmd, action, param }]),
    });
    const json = (await res.json()) as unknown;
    return unwrap(json);
  }

  async loginWorks(): Promise<boolean> {
    try {
      const r = await this.call('GetDevInfo', {}, 1);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * TRAP 4: `ModifyUser` with a plain `password` returns 200 and is ignored; only newPassword +
   * oldPassword works, and success is not evidence — verify with a fresh login.
   */
  async setAdminPassword(newPassword: string): Promise<void> {
    const r = await this.call('ModifyUser', {
      User: { userName: this.username, newPassword, oldPassword: this.password },
    });
    if (r.code !== 0) throw new Error(`ModifyUser failed: ${JSON.stringify(r)}`);
    const check = new Cgi(this.ip, this.username, newPassword, this.fetchImpl);
    if (!(await check.loginWorks())) {
      throw new Error('camera reported success but the new password does NOT work');
    }
    this.password = newPassword;
  }
}

export function unwrap(decoded: unknown): CgiResult {
  if (Array.isArray(decoded)) return (decoded[0] as CgiResult) ?? {};
  if (decoded && typeof decoded === 'object') {
    const d = decoded as Record<string, unknown>;
    if (Array.isArray(d.value)) return (d.value[0] as CgiResult) ?? {};
    return d as CgiResult;
  }
  return {};
}
