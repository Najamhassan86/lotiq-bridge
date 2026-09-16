import test from 'node:test';
import assert from 'node:assert/strict';
import type { BridgeJobApi } from './backendClient.ts';
import { FakeReolink } from './cameraDriver.ts';
import { runJob } from './jobRunner.ts';
import type { BridgeEvent, ProvisionJob } from './types.ts';

class FakeApi implements BridgeJobApi {
  events: BridgeEvent[] = [];
  committed = false;
  completed: Record<string, unknown> | null = null;
  async heartbeat(): Promise<void> {}
  async postEvents(_id: string, evs: BridgeEvent[]): Promise<void> {
    this.events.push(...evs);
  }
  async passwordCommitted(): Promise<void> {
    this.committed = true;
  }
  async complete(_id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.completed = body;
    return { ok: true };
  }
}

function job(): ProvisionJob {
  return {
    jobId: 'job#test',
    type: 'provision',
    uid: '9527000LG03YBYGG',
    deviceName: '61637-cam-demo',
    newPassword: 'Kt8mQ2vXpL4nR7cW9bZ3jF6h',
    candidatePasswords: [''],
    steps: [
      { id: 'time', cmd: 'SetTime', verifyCmd: 'GetTime', param: { Time: { timeZone: 18000 } }, expect: { 'Time.timeZone': 18000 } },
      {
        id: 'ftp',
        cmd: 'SetFtpV20',
        verifyCmd: 'GetFtpV20',
        param: { Ftp: { enable: 1, server: '61637.ftp.stg.lotiq.pro', userName: '61637-cam-demo', password: 's3cret', mode: 2, onlyFtps: 0 } },
        expect: { 'Ftp.enable': 1, 'Ftp.server': '61637.ftp.stg.lotiq.pro', 'Ftp.userName': '61637-cam-demo', 'Ftp.password': '*', 'Ftp.mode': 2, 'Ftp.onlyFtps': 0 },
      },
    ],
  };
}

test('healthy camera → succeeded, password committed', async () => {
  const api = new FakeApi();
  const result = await runJob(job(), new FakeReolink({ uid: '9527000LG03YBYGG' }), api);
  assert.equal(result.ok, true);
  assert.equal(api.committed, true);
  assert.equal(api.completed!.status, 'succeeded');
  assert.ok(api.events.filter((e) => e.status === 'ok').length >= 3);
});

test('camera that silently ignores FTP mode (trap 4) → failed, read-back catches it', async () => {
  const api = new FakeApi();
  const result = await runJob(job(), new FakeReolink({ uid: 'x', ignoreFtpMode: true }), api);
  assert.equal(result.ok, false);
  assert.equal(api.completed!.status, 'failed');
  assert.ok(result.problems!.some((p) => p.includes('mode')));
});

test('wrong current password fails the job', async () => {
  const api = new FakeApi();
  const result = await runJob(job(), new FakeReolink({ uid: 'x', password: 'SomethingElse1' }), api);
  assert.equal(result.ok, false);
  assert.equal(api.completed!.status, 'failed');
});
