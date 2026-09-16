import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aesEncrypt, bcXor, deriveAesKey, md5Modern, toHex } from './crypto.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, '__fixtures__', 'fixtures.json'), 'utf8'));
const enc = new TextEncoder();

test('md5Modern matches the golden vectors (31 upper-hex chars — trap 1)', () => {
  for (const v of fx.unit_vectors.md5_str_modern) {
    assert.equal(md5Modern(v.in), v.out, v.in);
    assert.equal(v.out.length, 31);
  }
});

test('bcXor matches the golden vectors', () => {
  for (const v of fx.unit_vectors.bc_xor) {
    assert.equal(toHex(bcXor(enc.encode(v.plain), v.offset)), v.out_hex, v.plain);
  }
});

test('aes-cfb128 matches the golden vectors (traps 2 & 3)', () => {
  for (const v of fx.unit_vectors.aes_cfb128) {
    const key = enc.encode(v.key_ascii); // ASCII bytes of the hex-looking string
    assert.equal(toHex(aesEncrypt(key, enc.encode(v.plain))), v.out_hex, v.plain);
  }
});

test('key derivation matches step 2 of the login handshake', () => {
  const { nonce, username, password } = fx.inputs;
  const d = fx.step2_derivation;
  assert.equal(md5Modern(username + nonce), d.user_hash);
  assert.equal(md5Modern(password + nonce), d.password_hash);
  // aes_key is the ASCII of md5Modern(nonce + "-" + password)[0:16]
  assert.equal(new TextDecoder().decode(deriveAesKey(nonce, password)), d.aes_key_ascii);
});

test('the login body encrypts with BC-XOR (not AES) to the golden ciphertext', () => {
  const s = fx.step3_login_frame;
  const cipher = toHex(bcXor(enc.encode(s.plaintext_xml), s.ch_id));
  assert.equal(cipher, s.encrypted_body_hex);
});

test('enable-HTTP body encrypts with AES-CFB128 to the golden ciphertext', () => {
  const s = fx.step4_enable_http;
  const { nonce, password } = fx.inputs;
  const cipher = toHex(aesEncrypt(deriveAesKey(nonce, password), enc.encode(s.plaintext_xml)));
  assert.equal(cipher, s.encrypted_body_hex);
});
