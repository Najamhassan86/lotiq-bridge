/**
 * Offline demo: run the bridge loop against a fake backend and a fake camera, no network. Proves the
 * runner logic in isolation. The real end-to-end test (against deployed staging) lives in
 * lotiq-backend/scripts/provisioning-e2e.mjs, which drives this same reference bridge.
 *
 *   node bin/demo.mjs
 */
import { runJob } from "../lib/jobRunner.mjs";
import { FakeReolink } from "../lib/cameraDriver.mjs";

// A minimal fake backend client capturing what the bridge would POST.
class FakeClient {
  constructor() { this.events = []; this.completed = null; this.committed = false; }
  async heartbeat() {}
  async postEvents(_id, evs) { this.events.push(...(Array.isArray(evs) ? evs : [evs])); }
  async passwordCommitted() { this.committed = true; }
  async complete(_id, body) { this.completed = body; }
}

const job = {
  jobId: "job#demo",
  type: "provision",
  uid: "9527000LG03YBYGG",
  deviceName: "61637-cam-demo",
  newPassword: "Kt8mQ2vXpL4nR7cW9bZ3jF6h",
  candidatePasswords: [""], // factory-fresh
  steps: [
    { id: "time", cmd: "SetTime", verifyCmd: "GetTime", param: { Time: { timeZone: 18000 } }, expect: { "Time.timeZone": 18000 } },
    {
      id: "ftp", cmd: "SetFtpV20", verifyCmd: "GetFtpV20",
      param: { Ftp: { enable: 1, server: "61637.ftp.stg.lotiq.pro", userName: "61637-cam-demo", password: "s3cret", mode: 2, onlyFtps: 0 } },
      expect: { "Ftp.enable": 1, "Ftp.server": "61637.ftp.stg.lotiq.pro", "Ftp.userName": "61637-cam-demo", "Ftp.password": "*", "Ftp.mode": 2, "Ftp.onlyFtps": 0 },
    },
  ],
};

console.log("=== healthy camera ===");
const okClient = new FakeClient();
const okResult = await runJob(job, new FakeReolink({ uid: job.uid }), okClient, { onEvent: (e) => console.log(`  ${e.step}: ${e.status}`) });
console.log("result:", okResult, "committed:", okClient.committed, "completed.status:", okClient.completed.status);

console.log("\n=== camera that silently ignores FTP mode (trap 4) — read-back must catch it ===");
const badClient = new FakeClient();
const badResult = await runJob(job, new FakeReolink({ uid: job.uid, ignoreFtpMode: true }), badClient, {});
console.log("result:", badResult, "completed.status:", badClient.completed.status, "problems:", badClient.completed.diff.problems);

if (okResult.ok && !badResult.ok && badClient.completed.diff.problems.some((p) => p.includes("mode"))) {
  console.log("\nDEMO OK");
} else {
  console.log("\nDEMO FAILED");
  process.exit(1);
}
