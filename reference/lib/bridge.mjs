/**
 * The bridge loop: pair once, then poll for jobs and run each until the session ends. This is the
 * reference for the Dart phone app's foreground loop (which additionally keeps the screen awake and
 * survives app-backgrounding — see README).
 */
import { BridgeBackendClient } from "./backendClient.mjs";
import { runJob } from "./jobRunner.mjs";

/**
 * @param {object} p
 * @param {string} p.baseUrl backend base URL
 * @param {string} p.pairCode the 6-digit code from the portal
 * @param {(job:object)=>Promise<object>} p.makeDriver returns a CameraDriver for a job's uid
 * @param {{ platform?: string, appVersion?: string, subnet?: string }} [p.info]
 * @param {number} [p.pollMs] idle poll interval
 * @param {number} [p.maxIdlePolls] stop after this many empty polls (0 = forever)
 * @param {(msg:string)=>void} [p.log]
 */
export async function runBridge({ baseUrl, pairCode, makeDriver, info = {}, pollMs = 1500, maxIdlePolls = 0, log = () => {} }) {
  const client = new BridgeBackendClient({ baseUrl });
  const paired = await client.pair(pairCode, info);
  log(`paired to session ${paired.session.sessionId} for property ${paired.session.propertyId}`);

  let idle = 0;
  const ran = [];
  for (;;) {
    let next;
    try {
      next = await client.nextJob(info.subnet);
    } catch (e) {
      if (e.status === 401) {
        log("session no longer active — stopping");
        break;
      }
      throw e;
    }
    if (!next.job) {
      idle += 1;
      if (maxIdlePolls && idle >= maxIdlePolls) break;
      await sleep(pollMs);
      continue;
    }
    idle = 0;
    const job = next.job;
    log(`running ${job.type} job ${job.jobId}${job.uid ? ` (uid ${job.uid})` : ""}`);
    const driver = await makeDriver(job);
    const result = await runJob(job, driver, client, { onEvent: (e) => log(`  ${e.step}: ${e.status}${e.detail ? ` — ${e.detail}` : ""}`) });
    ran.push({ jobId: job.jobId, type: job.type, result });
    log(`  -> ${result.ok ? "ok" : "FAILED"}${result.problems?.length ? `: ${result.problems.join("; ")}` : ""}`);
  }
  return { session: paired.session, ran };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
