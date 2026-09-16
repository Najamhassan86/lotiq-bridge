/**
 * runJob — carry out one backend job against a camera driver, reporting progress and a result.
 *
 * This is the heart of the bridge, and the part the Dart phone app ports most directly. The backend
 * hands down a fully-rendered job (secrets already filled, steps in order, each with its read-back
 * expectation); the runner just executes and verifies. It never decides what to set — that is the
 * backend's golden config — which is why adding a setting is a backend change, not an app release.
 */
import { diffExpect } from "./masking.mjs";

/**
 * @param {object} job the payload from POST /provision-bridge/jobs/next
 * @param {import("./cameraDriver.mjs").FakeReolink} driver a CameraDriver
 * @param {import("./backendClient.mjs").BridgeBackendClient} client
 * @param {{ deviceInfo?: object, onEvent?: (e:object)=>void }} [opts]
 */
export async function runJob(job, driver, client, opts = {}) {
  if (job.type === "discover") return runDiscover(job, driver, client, opts);
  if (job.type !== "provision") {
    await client.complete(job.jobId, { status: "failed", error: `bridge cannot run job type ${job.type}` });
    return { ok: false, error: `unsupported job type ${job.type}` };
  }
  return runProvision(job, driver, client, opts);
}

async function runProvision(job, driver, client, opts) {
  const t0 = Date.now();
  const emit = async (step, status, detail, ms) => {
    const ev = { step, status, detail, ms };
    opts.onEvent?.(ev);
    try { await client.postEvents(job.jobId, ev); } catch { /* progress is best-effort */ }
  };
  await client.heartbeat(job.jobId, { running: true });

  try {
    // 1. Log in with the passwords the backend supplied, in order (never guess — lockout budget).
    await emit("login", "start", `${job.candidatePasswords.length} candidate(s)`);
    await driver.login(job.candidatePasswords);
    await emit("login", "ok");

    // 2. Set the admin password, then tell the backend immediately (two-step commit): if the bridge
    //    dies after this, the backend still knows the camera's new password.
    const current = job.candidatePasswords.find((p) => p !== job.newPassword) ?? job.candidatePasswords[0] ?? "";
    await driver.setAdminPassword(current, job.newPassword);
    await client.passwordCommitted(job.jobId);
    await emit("password", "committed");

    // 3. Apply each golden-config step and read it back.
    const problems = [];
    for (const step of job.steps) {
      const s0 = Date.now();
      try {
        await driver.apply(step.cmd, step.param);
        if (step.verifyCmd) {
          const value = await driver.readBack(step.verifyCmd, step.verifyParam || {});
          const stepProblems = diffExpect(step.expect || {}, value);
          if (stepProblems.length) {
            if (step.optional) {
              await emit(step.id || step.cmd, "warn", `optional read-back mismatch: ${stepProblems.join("; ")}`, Date.now() - s0);
            } else {
              problems.push(...stepProblems.map((p) => `${step.id || step.cmd}.${p}`));
              await emit(step.id || step.cmd, "fail", stepProblems.join("; "), Date.now() - s0);
            }
          } else {
            await emit(step.id || step.cmd, "ok", undefined, Date.now() - s0);
          }
        } else {
          await emit(step.id || step.cmd, "ok", "(no read-back)", Date.now() - s0);
        }
      } catch (e) {
        if (step.optional) {
          await emit(step.id || step.cmd, "warn", `optional step error: ${e.message}`, Date.now() - s0);
        } else {
          problems.push(`${step.id || step.cmd}: ${e.message}`);
          await emit(step.id || step.cmd, "fail", e.message, Date.now() - s0);
        }
      }
    }

    // 4. Report the outcome. Read-back problems mean a failed provision even though every Set
    //    "succeeded" — this firmware reports success on settings it ignores (doc 02, trap 4).
    const readbackOk = problems.length === 0;
    const device = { uid: job.uid, model: driver.model, firmware: driver.firmware, ...(opts.deviceInfo || {}) };
    await client.complete(job.jobId, {
      status: readbackOk ? "succeeded" : "failed",
      diff: { readbackOk, problems },
      device,
      timings: { totalMs: Date.now() - t0 },
    });
    return { ok: readbackOk, problems };
  } catch (e) {
    await emit("provision", "fail", e.message);
    await client.complete(job.jobId, { status: "failed", diff: { readbackOk: false, problems: [e.message] }, error: e.message, timings: { totalMs: Date.now() - t0 } });
    return { ok: false, error: e.message };
  }
}

async function runDiscover(job, driver, client, opts) {
  await client.heartbeat(job.jobId, { running: true });
  // A real bridge sweeps the subnet here; the fake reports itself.
  const discovered = opts.discovered || [{ ip: "192.168.1.50", uid: driver.uid, model: driver.model, status: "ok" }];
  await client.postEvents(job.jobId, { step: "sweep", status: "ok", detail: `${discovered.length} found` });
  await client.complete(job.jobId, { status: "succeeded", diff: { discovered, found: discovered.length } });
  return { ok: true, discovered };
}
