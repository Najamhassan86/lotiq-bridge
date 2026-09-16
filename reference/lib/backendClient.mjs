/**
 * BridgeBackendClient — the on-site bridge's view of the LotIQ backend.
 *
 * The bridge only ever talks to `/api/v1/provision-bridge/*`, and only outbound: it pairs with a
 * 6-digit code the installer reads off the portal, then polls for jobs and reports progress. This is
 * the Node reference the Dart phone app mirrors call-for-call; keep the two in step.
 *
 * Uses global `fetch` (Node 18+) — no dependencies, so the same file runs in CI with nothing to
 * install.
 */
export class BridgeBackendClient {
  /** @param {{ baseUrl: string, fetchImpl?: typeof fetch }} opts */
  constructor({ baseUrl, fetchImpl }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.fetch = fetchImpl || fetch;
    this.token = null;
  }

  async _call(path, { method = "POST", body, auth = true } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth) {
      if (!this.token) throw new Error("bridge is not paired (no token)");
      headers.authorization = `Bearer ${this.token}`;
    }
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /** Redeem a pairing code. Stores the returned bearer token for every later call. */
  async pair(pairCode, info = {}) {
    const out = await this._call("/api/v1/provision-bridge/pair", {
      auth: false,
      body: { pairCode: String(pairCode), platform: info.platform, appVersion: info.appVersion, subnet: info.subnet },
    });
    this.token = out.token;
    return out;
  }

  /** Claim the next job, or `{ job: null }` when the queue is empty. */
  async nextJob(subnet) {
    return this._call("/api/v1/provision-bridge/jobs/next", { body: { subnet } });
  }

  heartbeat(jobId, { running = false } = {}) {
    return this._call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/heartbeat`, { body: { running } });
  }

  /** Append one or more progress events. */
  postEvents(jobId, events) {
    const list = Array.isArray(events) ? events : [events];
    return this._call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/events`, { body: { events: list } });
  }

  /** Tell the backend the admin password change succeeded, so it promotes the pending credential. */
  passwordCommitted(jobId) {
    return this._call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/password-committed`, { body: {} });
  }

  /** Report a job finished. `body` = { status, diff, device, timings, error }. */
  complete(jobId, body) {
    return this._call(`/api/v1/provision-bridge/jobs/${encodeURIComponent(jobId)}/complete`, { body });
  }
}
