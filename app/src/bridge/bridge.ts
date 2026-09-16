/**
 * The bridge loop: pair once, then poll for jobs and run each until the session ends. TS port of the
 * Node reference. In the app this runs while the screen is kept awake (see App.tsx).
 */
import { BridgeBackendClient, BridgeError } from './backendClient.ts';
import type { CameraDriver } from './cameraDriver.ts';
import { runJob } from './jobRunner.ts';
import type { JobResult, ProvisionJob } from './types.ts';

export type DriverFactory = (job: ProvisionJob) => Promise<CameraDriver>;

export interface BridgeRunSummary {
  session: Record<string, unknown>;
  ran: Array<{ jobId: string; type: string; result: JobResult }>;
}

export interface RunBridgeOpts {
  baseUrl: string;
  pairCode: string;
  makeDriver: DriverFactory;
  platform?: string;
  appVersion?: string;
  subnet?: string;
  pollMs?: number;
  maxIdlePolls?: number;
  log?: (message: string) => void;
  client?: BridgeBackendClient;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runBridge(opts: RunBridgeOpts): Promise<BridgeRunSummary> {
  const { baseUrl, pairCode, makeDriver, subnet, pollMs = 1500, maxIdlePolls = 0 } = opts;
  const log = opts.log ?? (() => {});
  const client = opts.client ?? new BridgeBackendClient(baseUrl);

  const paired = await client.pair(pairCode, { platform: opts.platform, appVersion: opts.appVersion, subnet });
  const session = paired.session as Record<string, unknown>;
  log(`paired to session ${session.sessionId} for property ${session.propertyId}`);

  let idle = 0;
  const ran: BridgeRunSummary['ran'] = [];
  for (;;) {
    let next: Record<string, unknown>;
    try {
      next = await client.nextJob(subnet);
    } catch (e) {
      if (e instanceof BridgeError && e.status === 401) {
        log('session no longer active — stopping');
        break;
      }
      throw e;
    }
    const job = next.job as ProvisionJob | null;
    if (!job) {
      idle += 1;
      if (maxIdlePolls > 0 && idle >= maxIdlePolls) break;
      await sleep(pollMs);
      continue;
    }
    idle = 0;
    log(`running ${job.type} job ${job.jobId}${job.uid ? ` (uid ${job.uid})` : ''}`);
    const driver = await makeDriver(job);
    const result = await runJob(job, driver, client, {
      onEvent: (e) => log(`  ${e.step}: ${e.status}${e.detail ? ` — ${e.detail}` : ''}`),
    });
    ran.push({ jobId: job.jobId, type: job.type, result });
    log(`  -> ${result.ok ? 'ok' : 'FAILED'}${result.problems?.length ? `: ${result.problems.join('; ')}` : ''}`);
  }
  return { session, ran };
}
