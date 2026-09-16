/**
 * BridgeBackendClient — the bridge's view of the LotIQ backend (`/api/v1/provision-bridge/*`).
 * TS port of the Node reference. Uses global `fetch` (present in React Native and Node 18+).
 * Session/job ids contain `#`, so every id in a path is percent-encoded.
 */
import type { BridgeEvent } from './types.ts';

export class BridgeError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** The subset a running job needs — lets the job runner be tested against a fake. */
export interface BridgeJobApi {
  heartbeat(jobId: string, opts?: { running?: boolean }): Promise<void>;
  postEvents(jobId: string, events: BridgeEvent[]): Promise<void>;
  passwordCommitted(jobId: string): Promise<void>;
  complete(jobId: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export class BridgeBackendClient implements BridgeJobApi {
  readonly baseUrl: string;
  token: string | null = null;
  private readonly _fetch: typeof fetch;

  constructor(baseUrl: string, opts: { fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this._fetch = opts.fetchImpl ?? fetch;
  }

  private async call(
    path: string,
    { body, auth = true }: { body?: Record<string, unknown>; auth?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) {
      if (!this.token) throw new Error('bridge is not paired (no token)');
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this._fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) throw new BridgeError(res.status, (json.error as string) ?? `HTTP ${res.status}`, json);
    return json;
  }

  async pair(
    pairCode: string,
    info: { platform?: string; appVersion?: string; subnet?: string } = {},
  ): Promise<Record<string, unknown>> {
    const out = await this.call('/api/v1/provision-bridge/pair', {
      auth: false,
      body: { pairCode, platform: info.platform, appVersion: info.appVersion, subnet: info.subnet },
    });
    this.token = (out.token as string) ?? null;
    return out;
  }

  nextJob(subnet?: string): Promise<Record<string, unknown>> {
    return this.call('/api/v1/provision-bridge/jobs/next', { body: { subnet } });
  }

  async heartbeat(jobId: string, opts: { running?: boolean } = {}): Promise<void> {
    await this.call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
      body: { running: opts.running ?? false },
    });
  }

  async postEvents(jobId: string, events: BridgeEvent[]): Promise<void> {
    await this.call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/events`, { body: { events } });
  }

  async passwordCommitted(jobId: string): Promise<void> {
    await this.call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/password-committed`, { body: {} });
  }

  complete(jobId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/complete`, { body });
  }
}
