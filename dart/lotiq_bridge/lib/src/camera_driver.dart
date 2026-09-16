/// CameraDriver — the small interface the job runner drives, plus a FakeReolink for tests and a
/// ReolinkDriver that speaks CGI to a real camera. Port of `../reference/lib/cameraDriver.mjs`.
///
/// The interface is deliberately small (mirrors installer doc 02 §2.11):
///   login(candidatePasswords) -> the password that worked, or throws (lockout budget lives here)
///   setAdminPassword(oldPw, newPw) -> ModifyUser (trap 4: only old+new works)
///   apply(cmd, param) -> a CGI Set command
///   readBack(verifyCmd, verifyParam) -> a CGI Get command (with the camera's field masking)
library;

import 'dart:convert';

import 'vendor/provisioner.dart' show Cgi;

abstract class CameraDriver {
  String get model;
  String get firmware;
  Future<String> login(List<String> candidatePasswords);
  Future<void> setAdminPassword(String oldPw, String newPw);
  Future<void> apply(String cmd, Map<String, dynamic> param);
  Future<dynamic> readBack(String verifyCmd, Map<String, dynamic> verifyParam);
}

/// Real camera over the CGI API. Assumes HTTP is already enabled (the bridge does that over
/// Baichuan during discovery, before building this). Hardware-validated separately — the crypto and
/// CGI transport are the vendored, conformance-tested core; this is a thin adapter over them.
class ReolinkDriver implements CameraDriver {
  final String ip;
  @override
  final String model;
  @override
  final String firmware;
  String _password;

  ReolinkDriver(this.ip, {this.model = '', this.firmware = '', String password = ''})
      : _password = password;

  Cgi get _cgi => Cgi(ip, password: _password);

  @override
  Future<String> login(List<String> candidatePasswords) async {
    for (final pw in candidatePasswords) {
      final cgi = Cgi(ip, password: pw);
      if (await cgi.loginWorks()) {
        _password = pw;
        return pw;
      }
    }
    throw StateError('no candidate password worked');
  }

  @override
  Future<void> setAdminPassword(String oldPw, String newPw) async {
    final cgi = Cgi(ip, password: oldPw);
    await cgi.setAdminPassword(newPw); // ModifyUser old+new, verified by a fresh login
    _password = newPw;
  }

  @override
  Future<void> apply(String cmd, Map<String, dynamic> param) async {
    final res = await _cgi.call(cmd, param);
    if (res['code'] != 0) {
      throw StateError('$cmd failed: ${jsonEncode(res)}');
    }
  }

  @override
  Future<dynamic> readBack(String verifyCmd, Map<String, dynamic> verifyParam) async {
    final res = await _cgi.call(verifyCmd, verifyParam, action: 0);
    // Cgi._unwrap returns the first envelope object; the value is under 'value'.
    return res['value'] ?? res['initial'] ?? res;
  }
}

/// A Reolink stand-in that behaves like the firmware where it matters: blank password on a factory
/// unit, ModifyUser needing old+new (a bare `password` is ignored — trap 4), and user/password
/// fields masked on read (so the masked compare is exercised). Stores whatever is applied and
/// returns it under the matching Get key, so a correct apply reads back clean.
class FakeReolink implements CameraDriver {
  @override
  final String model;
  @override
  final String firmware;
  final String uid;
  String password;
  int loginAttempts = 0;
  bool locked = false;
  final Map<String, dynamic> _store = {};

  /// When true, models the "SetFtpV20 saves but mode stays 0" silent-failure trap so a test can
  /// prove the read-back diff catches it.
  final bool ignoreFtpMode;

  FakeReolink({
    required this.uid,
    this.model = 'RLC-1224A',
    this.firmware = 'v3.2.0.5170_2510296888',
    this.password = '',
    this.ignoreFtpMode = false,
  });

  String _verifyKeyFor(String cmd) => cmd.startsWith('Set') ? 'Get${cmd.substring(3)}' : cmd;

  @override
  Future<String> login(List<String> candidatePasswords) async {
    for (final pw in candidatePasswords) {
      if (locked) throw StateError('camera locked (too many failed logins)');
      loginAttempts += 1;
      if (pw == password) return pw;
      if (loginAttempts >= 10) locked = true;
    }
    throw StateError('no candidate password worked');
  }

  @override
  Future<void> setAdminPassword(String oldPw, String newPw) async {
    if (oldPw != password) throw StateError('ModifyUser: oldPassword does not match');
    if (newPw.length < 6) throw StateError('ModifyUser: newPassword rejected');
    password = newPw;
  }

  @override
  Future<void> apply(String cmd, Map<String, dynamic> param) async {
    final key = _verifyKeyFor(cmd);
    final stored = jsonDecode(jsonEncode(param)) as Map<String, dynamic>;
    if (cmd == 'SetFtpV20' && ignoreFtpMode && stored['Ftp'] is Map) {
      (stored['Ftp'] as Map)['mode'] = 0; // the trap
    }
    _store[key] = stored;
  }

  @override
  Future<dynamic> readBack(String verifyCmd, Map<String, dynamic> verifyParam) async {
    final raw = _store[verifyCmd];
    if (raw == null) return <String, dynamic>{};
    final v = jsonDecode(jsonEncode(raw)) as Map<String, dynamic>;
    for (final block in ['Ftp', 'Email']) {
      if (v[block] is Map) {
        final m = v[block] as Map;
        if (m['userName'] is String) m['userName'] = _maskMiddle(m['userName'] as String);
        if (m['password'] is String) {
          final n = (m['password'] as String).length;
          m['password'] = '*' * (n < 4 ? 4 : (n > 64 ? 64 : n));
        }
      }
    }
    return v;
  }

  static String _maskMiddle(String s) {
    if (s.length <= 2) return s;
    return s[0] + '*' * (s.length - 2) + s[s.length - 1];
  }
}
