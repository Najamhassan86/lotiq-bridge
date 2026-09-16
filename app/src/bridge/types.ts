/** Shapes the bridge exchanges with the backend. Loose by design — the backend renders the steps. */

export interface JobStep {
  id?: string;
  cmd: string;
  param: Record<string, unknown>;
  verifyCmd?: string | null;
  verifyParam?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  optional?: boolean;
}

export interface ProvisionJob {
  jobId: string;
  type: 'discover' | 'identify' | 'provision' | 'readback';
  uid?: string;
  swap?: boolean;
  cameraId?: string;
  deviceName?: string;
  newPassword?: string;
  candidatePasswords?: string[];
  steps?: JobStep[];
  payload?: Record<string, unknown>;
}

export interface BridgeEvent {
  step: string;
  status: string;
  detail?: string;
  ms?: number;
}

export interface JobResult {
  ok: boolean;
  problems?: string[];
  error?: string;
  discovered?: unknown[];
}
