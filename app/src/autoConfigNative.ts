/**
 * FULL automatic camera setup — the "no Reolink app at all" path. Runs only in a dev build (it uses
 * the native TCP socket); it is NOT available in Expo Go.
 *
 * Flow, matching the proven `bc_provision_batch.py` reference:
 *   1. Baichuan (raw TCP, port 9000): log in with the camera's current admin password, read its UID,
 *      and ENABLE THE HTTP PORT. A camera can ship with HTTP off; only Baichuan can turn it on, and
 *      that is the one thing Expo Go could never do.
 *   2. CGI (HTTP, port 80): confirm the API is reachable, optionally rotate the admin password, then
 *      apply the backend-rendered FTP/time steps and read each one back.
 *
 * It degrades gracefully: if the Baichuan step fails but the HTTP API is already reachable (a camera
 * whose HTTP port is already on), it proceeds over CGI alone. A read-back mismatch is surfaced, never
 * hidden — this firmware reports success on settings it silently ignored (traps 4 & 5, see cgi.ts).
 */
import { BaichuanClient } from './bridge/baichuanClient.ts';
import { Cgi, diffExpect } from './bridge/index.ts';
import { rnSocketFactory } from './rnSocket.ts';
import type { InstallStep } from './backend/installerApi.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NativeConfigResult {
  ok: boolean;
  problems: string[];
  /** The camera's stable UID, read over Baichuan during login (null if that step was skipped). */
  uid: string | null;
  /** The admin password in effect after the run (rotated if a new one was given). */
  password: string;
  /** How the HTTP API became reachable — proof the Reolink app was not needed. */
  httpOpenedVia: 'baichuan' | 'already-open';
}

export async function autoConfigureNative({
  ip,
  currentPassword,
  newPassword,
  steps,
  log,
}: {
  ip: string;
  currentPassword: string;
  newPassword?: string;
  steps: InstallStep[];
  log: (line: string) => void;
}): Promise<NativeConfigResult> {
  const host = ip.trim();
  let uid: string | null = null;
  let httpOpenedVia: 'baichuan' | 'already-open' = 'already-open';

  // 1. Baichuan (raw TCP 9000): login, read UID, open the HTTP port.
  log(`Connecting to ${host} over Baichuan…`);
  try {
    const bc = new BaichuanClient(host, { socketFactory: rnSocketFactory, password: currentPassword });
    await bc.connect();
    await bc.login();
    log('✓ camera login (Baichuan)');
    await bc.setPortEnabled('http', true);
    httpOpenedVia = 'baichuan';
    log('✓ HTTP port enabled on camera');
    try {
      uid = await bc.getUid();
      if (uid) log(`  UID ${uid}`);
    } catch {
      /* UID is best-effort — HTTP is already open */
    }
    await bc.close();
  } catch (e) {
    log(`Baichuan step skipped (${e instanceof Error ? e.message : String(e)}); trying HTTP directly…`);
  }

  // 2. CGI (HTTP 80): confirm the API is reachable (retry — the port takes a moment to come up).
  let password = currentPassword;
  let cgi = new Cgi(host, 'admin', password);
  let reachable = false;
  for (let i = 0; i < 8; i++) {
    if (await cgi.loginWorks()) {
      reachable = true;
      break;
    }
    await sleep(800);
  }
  if (!reachable) {
    throw new Error(
      `Camera HTTP API not reachable at ${host}. Baichuan could not open the port and it isn't already on — ` +
        `check the IP and the current admin password.`,
    );
  }
  log('✓ HTTP API reachable');

  // 3. Optional: rotate the admin password (ModifyUser old+new, verified by a fresh login).
  if (newPassword && newPassword !== password) {
    await cgi.setAdminPassword(newPassword);
    password = newPassword;
    cgi = new Cgi(host, 'admin', password);
    log('✓ admin password rotated');
  }

  // 4. Apply the backend-rendered steps and read each one back.
  const problems: string[] = [];
  for (const step of steps) {
    const r = await cgi.call(step.cmd, step.param);
    if (r.code !== 0) throw new Error(`${step.cmd} failed: ${JSON.stringify(r)}`);
    if (step.verifyCmd) {
      const read = await cgi.call(step.verifyCmd, step.verifyParam ?? {}, 0);
      const value = (read.value ?? read.initial ?? read) as unknown;
      problems.push(...diffExpect(step.expect ?? {}, value).map((p) => `${step.id ?? step.cmd}.${p}`));
    }
    log(`• ${step.id ?? step.cmd} applied${step.verifyCmd ? ' + verified' : ''}`);
  }

  return { ok: problems.length === 0, problems, uid, password, httpOpenedVia };
}
