import test from 'node:test';
import assert from 'node:assert/strict';
import { diffExpect, getPath, matchesMasked } from './readback.ts';

test('matchesMasked: exact, masked, numeric-string, mismatches', () => {
  assert.equal(matchesMasked('ftp.lotiq.pro', 'ftp.lotiq.pro'), true);
  assert.equal(matchesMasked('ft***er', 'ftpuser'), true);
  assert.equal(matchesMasked('cam-b*****1224a@lotiq.pro', 'cam-bench-1224a@lotiq.pro'), true);
  assert.equal(matchesMasked(21, '21'), true);
  assert.equal(matchesMasked('2', 2), true);
  assert.equal(matchesMasked('ft***er', 'ftpusers'), false);
  assert.equal(matchesMasked('fa***er', 'ftpuser'), false);
  assert.equal(matchesMasked(null, 'x'), false);
  assert.equal(matchesMasked(0, 2), false);
});

test('getPath walks objects and arrays', () => {
  const v = { Ftp: { schedule: { table: { TIMING: '111' } }, ports: [21, 40000] } };
  assert.equal(getPath(v, 'Ftp.schedule.table.TIMING'), '111');
  assert.equal(getPath(v, 'Ftp.ports.1'), 40000);
  assert.equal(getPath(v, 'Ftp.missing.deeper'), undefined);
  assert.equal(getPath(null, 'a'), undefined);
});

test('diffExpect reports mismatches and honours the * wildcard', () => {
  const value = {
    Ftp: { server: '61637.ftp.stg.lotiq.pro', port: 21, mode: 0, onlyFtps: 1, userName: '61***b', password: '******' },
  };
  const problems = diffExpect(
    {
      'Ftp.server': '61637.ftp.stg.lotiq.pro',
      'Ftp.port': 21,
      'Ftp.mode': 2,
      'Ftp.onlyFtps': 0,
      'Ftp.userName': '61637-cam-7f3a9c2b',
      'Ftp.password': '*',
      'Ftp.autoDir': 1,
    },
    value,
  );
  assert.deepEqual(
    problems.map((p) => p.split(':')[0]),
    ['Ftp.mode', 'Ftp.onlyFtps', 'Ftp.userName', 'Ftp.autoDir'],
  );
});
