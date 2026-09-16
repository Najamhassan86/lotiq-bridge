/**
 * Baichuan frame construction — the wire format from the porting spec, ported to TS and checked
 * against the golden `full_frame_hex` vectors in frames.test.ts. Two header variants, both
 * little-endian:
 *   Class 1465 — 20 bytes, bare nonce request only (mess_len 0).
 *   Class 1464 — 24 bytes, everything else (mess_len = PLAINTEXT body length; payload_off 0).
 */
import { aesEncrypt, bcXor } from './crypto.ts';

const MAGIC = [0xf0, 0xde, 0xbc, 0x0a];
export const HOST_CH_ID = 250;

function le(value: number, bytes: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) out.push((value >> (8 * i)) & 0xff);
  return out;
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

/** 20-byte class-1465 header (nonce request): magic, cmd, len=0, ch_id, mess_id, 12dc1465. */
export function header1465(cmdId: number, messId: number, chId = HOST_CH_ID): Uint8Array {
  return Uint8Array.from([
    ...MAGIC,
    ...le(cmdId, 4),
    ...le(0, 4),
    chId & 0xff,
    ...le(messId, 3),
    ...hexBytes('12dc1465'),
  ]);
}

/** 24-byte class-1464 header: magic, cmd, plaintext-len, ch_id, mess_id, 00001464, payload_off=0. */
export function header1464(cmdId: number, messLen: number, messId: number, chId = HOST_CH_ID): Uint8Array {
  return Uint8Array.from([
    ...MAGIC,
    ...le(cmdId, 4),
    ...le(messLen, 4),
    chId & 0xff,
    ...le(messId, 3),
    ...hexBytes('00001464'),
    ...le(0, 4),
  ]);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const utf8 = new TextEncoder();

/** The full nonce-request frame (cmd 1, class 1465, empty body). */
export function nonceFrame(messId = 1): Uint8Array {
  return header1465(1, messId);
}

/** The full login frame: cmd 1, class 1464, body = LoginUser XML, BC-XOR encrypted at ch_id offset. */
export function loginFrame(loginXml: string, messId = 2, chId = HOST_CH_ID): Uint8Array {
  const body = utf8.encode(loginXml);
  return concat(header1464(1, body.length, messId, chId), bcXor(body, chId));
}

/** A post-login command frame: class 1464, body AES-CFB128 encrypted with the session key. */
export function aesCommandFrame(cmdId: number, xml: string, aesKey: Uint8Array, messId: number, chId = HOST_CH_ID): Uint8Array {
  const body = utf8.encode(xml);
  return concat(header1464(cmdId, body.length, messId, chId), aesEncrypt(aesKey, body));
}
