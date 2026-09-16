import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { toHex, deriveAesKey } from './crypto.ts';
import { header1464, header1465, loginFrame, aesCommandFrame } from './frames.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, '__fixtures__', 'fixtures.json'), 'utf8'));

test('class-1465 nonce header matches the golden header (20 bytes)', () => {
  const s1 = fx.step1_nonce_request;
  assert.equal(toHex(header1465(s1.cmd_id, s1.mess_id)), s1.header_hex);
  assert.equal(header1465(s1.cmd_id, s1.mess_id).length, 20);
});

// mess_id is not in the fixtures — it is sequential over the connection: nonce=1, login=2,
// enable-HTTP=3, get-ports=4 — and the golden full_frame_hex encodes those values.
const LOGIN_MESS_ID = 2;
const ENABLE_HTTP_MESS_ID = 3;

test('class-1464 login header matches the golden header (24 bytes)', () => {
  const s3 = fx.step3_login_frame;
  assert.equal(toHex(header1464(s3.cmd_id, s3.plaintext_len, LOGIN_MESS_ID, s3.ch_id)), s3.header_hex);
  assert.equal(header1464(s3.cmd_id, s3.plaintext_len, LOGIN_MESS_ID, s3.ch_id).length, 24);
});

test('full login frame matches the golden bytes (BC-XOR body)', () => {
  const s3 = fx.step3_login_frame;
  assert.equal(toHex(loginFrame(s3.plaintext_xml, LOGIN_MESS_ID, s3.ch_id)), s3.full_frame_hex);
});

test('full enable-HTTP frame matches the golden bytes (AES-CFB128 body)', () => {
  const s4 = fx.step4_enable_http;
  const { nonce, password } = fx.inputs;
  const key = deriveAesKey(nonce, password);
  assert.equal(toHex(aesCommandFrame(s4.cmd_id, s4.plaintext_xml, key, ENABLE_HTTP_MESS_ID)), s4.full_frame_hex);
});
