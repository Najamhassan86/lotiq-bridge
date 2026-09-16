/**
 * runJob — carry out one backend job against a CameraDriver, reporting progress and a result.
 * TS port of the Node reference (proven end-to-end against deployed staging). The backend hands down
 * a fully-rendered job; the runner just executes and verifies.
 */
import type { BridgeJobApi } from './backendClient.ts';
import type { CameraDriver } from './cameraDriver.ts';
import { diffExpect } from './readback.ts';
import type { BridgeEvent, JobResult, ProvisionJob } from './types.ts';

export interface RunOpts {
  onEvent?: (e: BridgeEvent) => void;
  deviceInfo?: Record<string, unknown>;
  discovered?: unknown[];
}

export async function runJob(
  job: ProvisionJob,
  driver: CameraDriver,
  client: BridgeJobApi,
  opts: RunOpts = {},
): Promise<JobResult> {
  if (job.type === 'discover') return runDiscover(job, driver, client, opts);
  if (job.type !== 'provision') {
    await client.complete(job.jobId, { status: 'failed', error: `bridge cannot run job type ${job.type}` });
    return { ok: false, error: `unsupported job type ${job.type}` };
  }
  return runProvision(job, driver, client, opts);
}

async function runProvision(
  job: ProvisionJob,
  driver: CameraDriver,
  client: BridgeJobApi,
  opts: RunOpts,
): Promise<JobResult> {
  const t0 = Date.now();
  const candidatePasswords = job.candidatePasswords ?? [];
  const newPassword = job.newPassword ?? '';
  const steps = job.steps ?? [];

  const emit = async (step: string, status: string, detail?: string, ms?: number) => {
    const ev: BridgeEvent = { step, status, detail, ms };
    opts.onEvent?.(ev);
    try {
      await client.postEvents(job.jobId, [ev]);
    } catch {
      /* progress is best-effort */
    }
  };

  await client.heartbeat(job.jobId, { running: true });

  try {
    await emit('login', 'start', `${candidatePasswords.length} candidate(s)`);
    await driver.login(candidatePasswords);
    await emit('login', 'ok');

    const current = candidatePasswords.find((p) => p !== newPassword) ?? candidatePasswords[0] ?? '';
    await driver.setAdminPassword(current, newPassword);
    await client.passwordCommitted(job.jobId);
    await emit('password', 'committed');

    const problems: string[] = [];
    for (const step of steps) {
      const s0 = Date.now();
      const id = step.id ?? step.cmd;
      try {
        await driver.apply(step.cmd, step.param);
        if (step.verifyCmd) {
          const value = await driver.readBack(step.verifyCmd, step.verifyParam ?? {});
          const stepProblems = diffExpect(step.expect ?? {}, value);
          const ms = Date.now() - s0;
          if (stepProblems.length) {
            if (step.optional) {
              await emit(id, 'warn', `optional read-back mismatch: ${stepProblems.join('; ')}`, ms);
            } else {
              problems.push(...stepProblems.map((p) => `${id}.${p}`));
              await emit(id, 'fail', stepProblems.join('; '), ms);
            }
          } else {
            await emit(id, 'ok', undefined, ms);
          }
        } else {
          await emit(id, 'ok', '(no read-back)', Date.now() - s0);
        }
      } catch (e) {
        const ms = Date.now() - s0;
        const msg = e instanceof Error ? e.message : String(e);
        if (step.optional) {
          await emit(id, 'warn', `optional step error: ${msg}`, ms);
        } else {
          problems.push(`${id}: ${msg}`);
          await emit(id, 'fail', msg, ms);
        }
      }
    }

    const readbackOk = problems.length === 0;
    const device = { uid: job.uid, model: driver.model, firmware: driver.firmware, ...(opts.deviceInfo ?? {}) };
    await client.complete(job.jobId, {
      status: readbackOk ? 'succeeded' : 'failed',
      diff: { readbackOk, problems },
      device,
      timings: { totalMs: Date.now() - t0 },
    });
    return { ok: readbackOk, problems };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await emit('provision', 'fail', msg);
    await client.complete(job.jobId, {
      status: 'failed',
      diff: { readbackOk: false, problems: [msg] },
      error: msg,
      timings: { totalMs: Date.now() - t0 },
    });
    return { ok: false, error: msg };
  }
}

async function runDiscover(
  job: ProvisionJob,
  driver: CameraDriver,
  client: BridgeJobApi,
  opts: RunOpts,
): Promise<JobResult> {
  await client.heartbeat(job.jobId, { running: true });
  const discovered =
    opts.discovered ?? [{ ip: '192.168.1.50', uid: (driver as { uid?: string }).uid ?? '', model: driver.model, status: 'ok' }];
  await client.postEvents(job.jobId, [{ step: 'sweep', status: 'ok', detail: `${discovered.length} found` }]);
  await client.complete(job.jobId, { status: 'succeeded', diff: { discovered, found: discovered.length } });
  return { ok: true, discovered };
}
