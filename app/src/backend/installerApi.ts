/**
 * Typed client for the installer half of the provisioning API
 * (`/api/v1/installer/provisioning/*`, backend `src/routes/provisioning.js`). Bearer-authed with the
 * Cognito IdToken. Pure `fetch`, so it runs in Expo Go and in a dev build alike.
 */
import { CONFIG } from './config.ts';
import type { ProvisionJob } from '../bridge/index.ts';

export interface PropertyPick {
  propertyId: string; // public id
  dynamoId: string; // what /sessions expects
  name: string;
  timeZone: string | null;
  hasTimeZone: boolean;
}

export interface InstallSession {
  sessionId: string;
  propertyId: string;
  status: string;
}

export interface KnownDevice {
  cameraId: string | null;
  model: string | null;
  firmware: string | null;
}

export interface Position {
  cameraId: string;
  cameraSlug: string;
  name: string;
  label: string | null;
  lotId: string | null;
  positionNo: number | null;
  intendedModel: string | null;
  ftpHost: string | null;
  configProfileId: string | null;
  status: string;
  boundUid: string | null;
  ready: boolean;
}

export interface ProvisionNowResult {
  job: ProvisionJob;
  cameraId: string;
  cameraSlug: string;
  observed?: Record<string, unknown>;
}

export interface InstallStep {
  id?: string;
  cmd: string;
  param: Record<string, unknown>;
  verifyCmd?: string | null;
  verifyParam?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  optional?: boolean;
}

export interface InstallSheet {
  camera: { propertyId: string; cameraSlug: string; name: string; deviceName: string };
  ftp: {
    server: string;
    port: number;
    username: string;
    password: string;
    passiveMode: boolean;
    remoteDirectory: string;
    createSubfolders: boolean;
    stream: string;
    maxFileSizeMb: number;
    stillEverySeconds: number;
    uploadSchedule: string;
  };
  time: { timeZone: string; ntpOn: boolean };
  destination: string;
  profile: { profileId: string; name: string };
}

export interface CompleteBody {
  status: 'succeeded' | 'failed';
  diff: { readbackOk: boolean; problems: string[] };
  device: Record<string, unknown>;
  appVersion?: string;
  timings?: Array<{ step: string; ms: number }>;
  snapshotKey?: string;
  depressionAngleDeg?: number;
  error?: string;
}

const enc = encodeURIComponent;

export class InstallerApi {
  constructor(
    private readonly idToken: string,
    private readonly baseUrl: string = CONFIG.apiBaseUrl,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.idToken}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = (json as Record<string, unknown>).error ?? `${res.status}`;
      throw new Error(String(err));
    }
    return json as T;
  }

  async listProperties(): Promise<PropertyPick[]> {
    const r = await this.call<{ properties: PropertyPick[] }>('GET', '/api/v1/installer/provisioning/properties');
    return r.properties ?? [];
  }

  /** Camera positions the super admin created for a property — the technician picks one to provision. */
  async listPositions(propertyDynamoId: string): Promise<Position[]> {
    const r = await this.call<{ positions: Position[] }>(
      'GET',
      `/api/v1/installer/provisioning/properties/${enc(propertyDynamoId)}/positions`,
    );
    return r.positions ?? [];
  }

  async knownDevices(uids: string[]): Promise<Record<string, KnownDevice>> {
    const r = await this.call<{ known: Record<string, KnownDevice> }>(
      'POST',
      '/api/v1/installer/provisioning/known-devices',
      { uids },
    );
    return r.known ?? {};
  }

  /** The manual-install sheet for a position — the exact settings to type into the Reolink app. */
  async getInstallSheet(cameraId: string): Promise<InstallSheet> {
    const r = await this.call<{ sheet: InstallSheet }>(
      'GET',
      `/api/v1/installer/provisioning/positions/${enc(cameraId)}/install-sheet`,
    );
    return r.sheet;
  }

  /** The camera CGI steps to apply for automatic (over-Wi-Fi) setup of a position. */
  async getInstallSteps(cameraId: string): Promise<InstallStep[]> {
    const r = await this.call<{ steps: InstallStep[] }>(
      'GET',
      `/api/v1/installer/provisioning/positions/${enc(cameraId)}/install-steps`,
    );
    return r.steps ?? [];
  }

  /** Record that a position was configured (moves it to awaiting_footage). */
  async markConfigured(cameraId: string, body: { uid?: string } = {}): Promise<void> {
    await this.call('POST', `/api/v1/installer/provisioning/positions/${enc(cameraId)}/mark-configured`, {
      uid: body.uid,
      appVersion: CONFIG.appVersion,
    });
  }

  /** Provision the identified camera (`uid`) into a pre-created position (`cameraId`, required). No session. */
  async provisionNow(
    body: { cameraId: string; uid: string; device?: Record<string, unknown>; ftpHost?: string; profileId?: string; swap?: boolean },
  ): Promise<ProvisionNowResult> {
    return this.call<ProvisionNowResult>('POST', '/api/v1/installer/provisioning/provision-now', body);
  }

  async passwordCommitted(jobId: string): Promise<void> {
    await this.call('POST', `/api/v1/installer/provisioning/jobs/${enc(jobId)}/password-committed`, {});
  }

  async sendEvents(jobId: string, events: Array<{ step: string; status: string; detail?: string; ms?: number }>): Promise<void> {
    await this.call('POST', `/api/v1/installer/provisioning/jobs/${enc(jobId)}/events`, { events });
  }

  async complete(jobId: string, body: CompleteBody): Promise<{ ok: boolean; readbackOk?: boolean }> {
    return this.call('POST', `/api/v1/installer/provisioning/jobs/${enc(jobId)}/complete`, body);
  }
}
