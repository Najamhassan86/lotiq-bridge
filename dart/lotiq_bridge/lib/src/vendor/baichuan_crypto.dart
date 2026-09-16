/// Baichuan crypto primitives — direct port of bc_prove.py.
///
/// Every function here is covered by fixtures.json. Run the tests before
/// pointing this at a camera.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:pointycastle/api.dart' show KeyParameter;
import 'package:pointycastle/block/aes.dart';

/// TRAP 1: the vendor truncates the MD5 hex to 31 chars, not 32.
/// An odd-length hex string. A 32-char hash fails auth with no useful error.
String md5Modern(String s) {
  final digest = crypto.md5.convert(utf8.encode(s));
  final hex = digest.bytes
      .map((b) => b.toRadixString(16).padLeft(2, '0'))
      .join();
  return hex.substring(0, 31).toUpperCase();
}

const List<int> _xmlKey = [0x1F, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78, 0xFF];

/// BC XOR cipher. Offset is ch_id (250 for host).
/// Used for the LOGIN body and for decrypting class-1466 replies.
Uint8List bcXor(List<int> buf, int offset) {
  final off = offset % 256;
  final out = Uint8List(buf.length);
  for (var i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ _xmlKey[(off + i) % 8] ^ off;
  }
  return out;
}

final Uint8List _aesIv = Uint8List.fromList(utf8.encode('0123456789abcdef'));

/// TRAP 2: CFB *128*, not CFB8. Built here from the raw AES block function
/// so no library's CFB segment-size default can silently differ.
///
/// TRAP 3: `key` is the ASCII BYTES of a 16-char hex-looking string, NOT that
/// string hex-decoded. Sixteen chars is already AES-128 length.
Uint8List _cfb128(Uint8List key, List<int> data, {required bool encrypt}) {
  final aes = AESEngine()..init(true, KeyParameter(key)); // always ENCRYPT direction
  final out = Uint8List(data.length);
  var prev = Uint8List.fromList(_aesIv);

  for (var i = 0; i < data.length; i += 16) {
    final ks = Uint8List(16);
    aes.processBlock(prev, 0, ks, 0);

    final n = (i + 16 <= data.length) ? 16 : data.length - i;
    for (var j = 0; j < n; j++) {
      out[i + j] = data[i + j] ^ ks[j];
    }

    // feedback is the CIPHERTEXT block in both directions
    final fb = Uint8List(16);
    for (var j = 0; j < n; j++) {
      fb[j] = encrypt ? out[i + j] : data[i + j];
    }
    prev = fb;
  }
  return out;
}

Uint8List aesEncrypt(Uint8List key, List<int> body) =>
    _cfb128(key, body, encrypt: true);

Uint8List aesDecrypt(Uint8List key, List<int> data) =>
    _cfb128(key, data, encrypt: false);

/// Derive the session AES key. Note the LITERAL HYPHEN between nonce and
/// password — it is not present in the user/password hashes.
Uint8List deriveAesKey(String nonce, String password) =>
    Uint8List.fromList(utf8.encode(md5Modern('$nonce-$password').substring(0, 16)));
