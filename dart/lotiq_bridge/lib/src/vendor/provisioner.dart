/// LAN discovery + the full provisioning flow.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'baichuan_client.dart';

class Discovered {
  final String ip;
  final String? uid, model, name;
  final String status; // ok | auth | error
  Discovered(this.ip, {this.uid, this.model, this.name, this.status = 'ok'});
}

/// Sweep a /24 for TCP 9000, then read the UID from each responder.
/// Port of bc_discover.py.
class Discovery {
  static Future<String?> localSubnet() async {
    for (final iface in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
      for (final a in iface.addresses) {
        if (!a.isLoopback && a.address.startsWith(RegExp(r'10\.|192\.168\.|172\.'))) {
          final p = a.address.split('.');
          return '${p[0]}.${p[1]}.${p[2]}';
        }
      }
    }
    return null;
  }

  static Future<bool> _open(String ip, Duration t) async {
    try {
      final s = await Socket.connect(ip, bcPort, timeout: t);
      s.destroy();
      return true;
    } catch (_) {
      return false;
    }
  }

  /// Sweep a /24 for TCP 9000.
  ///
  /// Concurrency is capped deliberately. Firing all 254 connects at once is
  /// fine on desktop but iOS throttles it, and cameras were intermittently
  /// missed - one run found 1 host, the next found 2, on the same network.
  /// A bounded batch with a longer timeout is a few seconds slower and
  /// deterministic, which is the right trade for someone on a ladder.
  static Future<List<String>> sweep(
    String prefix, {
    Duration timeout = const Duration(milliseconds: 1500),
    int concurrency = 32,
    void Function(double)? onProgress,
  }) async {
    final hits = <String>[];
    var done = 0;
    for (var start = 1; start <= 254; start += concurrency) {
      final end = (start + concurrency - 1).clamp(1, 254);
      await Future.wait([
        for (var i = start; i <= end; i++)
          () async {
            final ip = '$prefix.$i';
            if (await _open(ip, timeout)) hits.add(ip);
            onProgress?.call(++done / 254);
          }()
      ]);
    }
    hits.sort((a, b) =>
        int.parse(a.split('.').last).compareTo(int.parse(b.split('.').last)));
    return hits;
  }

  static Future<Discovered> interrogate(String ip, {String password = ''}) async {
    final cam = BaichuanClient(ip, password: password);
    try {
      await cam.connect();
      await cam.login();
      final info = await cam.getInfo();
      final uid = await cam.getUid();
      return Discovered(ip,
          uid: uid, model: info.model, name: info.name, status: 'ok');
    } on BaichuanAuthException {
      return Discovered(ip, status: 'auth');
    } catch (_) {
      return Discovered(ip, status: 'error');
    } finally {
      await cam.close();
    }
  }

  /// Scan QR -> find that camera's IP.
  ///
  /// Throws a [FindFailure] that distinguishes the three ways this fails.
  /// Collapsing them into "not found on this network" sent a real installer
  /// hunting a network problem when the password was simply wrong.
  static Future<Discovered> findByUid(
    String uid, {
    String password = '',
    String? subnet,
    void Function(String)? onLog,
  }) async {
    final prefix = subnet ?? await localSubnet();
    if (prefix == null) {
      throw FindFailure(FindProblem.noSubnet,
          'Could not work out the local subnet. Enter one in Subnet override.');
    }

    onLog?.call('sweeping $prefix.0/24 for port $bcPort');
    final hits = await sweep(prefix);
    onLog?.call('${hits.length} host(s) on $bcPort');

    if (hits.isEmpty) {
      throw FindFailure(FindProblem.noHosts,
          'No cameras on $prefix.0/24. Check you are on the property WiFi - '
          'not guest WiFi and not cellular. On iOS, local network access must '
          'be allowed.');
    }

    final results = <Discovered>[];
    for (final ip in hits) {
      results.add(await interrogate(ip, password: password));
    }

    final want = uid.trim().toUpperCase();
    for (final r in results) {
      if (r.uid != null && r.uid!.toUpperCase() == want) {
        onLog?.call('matched $uid at ${r.ip}');
        return r;
      }
    }

    final authed = results.where((r) => r.status == 'ok').toList();
    if (authed.isEmpty) {
      throw FindFailure(FindProblem.authFailed,
          'Found ${hits.length} camera(s) but could not log in to any. The '
          'current password is wrong. If the Reolink app shows the camera as '
          'uninitialized, leave Current pw BLANK. Cameras lock after 10 failed '
          'attempts - do not keep guessing.');
    }

    final seen = authed.map((r) => r.uid ?? '?').join(', ');
    throw FindFailure(FindProblem.uidMismatch,
        'Logged in to ${authed.length} camera(s), but none has UID $uid. '
        'Found: $seen');
  }
}

/// FTP upload settings. Field names confirmed against RLC-1224A fw 5170
/// and Duo 3 PoE.
class FtpConfig {
  /// ALWAYS a hostname, never an IP. The camera stores this permanently, and
  /// changing it later means reaching every camera again.
  final String server;
  final int port;
  final String userName;
  final String password;

  /// The camera appends YYYY/MM/DD/ under this when autoDir is 1.
  final String remoteDir;

  /// 1 = Fluent (sub-stream), 0 = Clear (main stream).
  final int streamType;

  /// MB per file. 10 is the firmware MINIMUM - smaller values are rejected.
  /// There is no duration-based splitting on this build (packTime is absent).
  final int maxSize;

  final int interval;
  final int picInterval;

  /// Transport mode. **2 = passive. This is not optional.**
  ///
  /// The camera defaults to 0 ("auto"), which resolves to ACTIVE FTP - the
  /// server connects back to the camera for the data channel. That is
  /// impossible at a property behind CGNAT, and it silently fails: settings
  /// save fine, TestFtp fails with a generic -450, and nothing uploads.
  final int mode;

  /// **0 = plain FTP. The camera ships with this set to 1 (FTPS required).**
  ///
  /// Left at the default, every camera demands TLS and our vsftpd refuses.
  /// Another silent failure - must be set explicitly on every camera.
  final int onlyFtps;

  final int autoDir;

  /// Upload schedule: 168 chars, 7 days x 24 hours, "1" = upload in that hour.
  ///
  /// **TIMING all-on = continuous upload. This is what we want.**
  ///
  /// A factory-fresh camera has TIMING OFF and only the event triggers on, so
  /// it uploads on motion and nothing else. Left alone, every camera ships
  /// event-triggered - and the gap only shows up when someone needs footage
  /// from a quiet period, which is exactly when a slip-and-fall claim lands.
  ///
  /// Event triggers are turned OFF here: with continuous upload they add
  /// nothing but duplicate files.
  final Map<String, String> schedule;

  static const String _allOn =
      '111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111';
  static const String _allOff =
      '000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

  /// Continuous 24x7 upload. The default, and what doc 01 specifies.
  static Map<String, String> continuousSchedule() => {
        'TIMING': _allOn,
        'MD': _allOff,
        'AI_PEOPLE': _allOff,
        'AI_VEHICLE': _allOff,
        'AI_DOG_CAT': _allOff,
      };

  /// Event-triggered only. Leaves gaps - use deliberately, not by accident.
  static Map<String, String> eventSchedule() => {
        'TIMING': _allOff,
        'MD': _allOn,
        'AI_PEOPLE': _allOn,
        'AI_VEHICLE': _allOn,
        'AI_DOG_CAT': _allOn,
      };

  const FtpConfig({
    required this.server,
    required this.userName,
    required this.password,
    required this.remoteDir,
    this.port = 21,
    this.streamType = 1,
    this.maxSize = 10,
    this.interval = 1800,
    this.picInterval = 30,
    this.mode = 2,        // passive - see above, do not change to 0
    this.onlyFtps = 0,    // plain FTP - camera defaults to 1
    this.autoDir = 1,
    Map<String, String>? schedule,
  }) : schedule = schedule ?? const {
          'TIMING': _allOn,
          'MD': _allOff,
          'AI_PEOPLE': _allOff,
          'AI_VEHICLE': _allOff,
          'AI_DOG_CAT': _allOff,
        };

  Map<String, dynamic> toJson() => {
        'enable': 1,
        'server': server,
        'port': port,
        'userName': userName,
        'password': password,
        'mode': mode,
        'onlyFtps': onlyFtps,
        'remoteDir': remoteDir,
        'autoDir': autoDir,
        'streamType': streamType,
        'interval': interval,
        'maxSize': maxSize,
        'picInterval': picInterval,
        'schedule': {'channel': 0, 'table': schedule},
      };
}

enum FindProblem { noSubnet, noHosts, authFailed, uidMismatch }

class FindFailure implements Exception {
  final FindProblem problem;
  final String message;
  FindFailure(this.problem, this.message);
  @override
  String toString() => message;
}

/// CGI (HTTP) layer — everything after Baichuan opens port 80.
class Cgi {
  final String ip, username, password;
  Cgi(this.ip, {this.username = 'admin', this.password = ''});

  Future<Map<String, dynamic>> call(String cmd, Map<String, dynamic> param,
      {int action = 0}) async {
    // Uri.replace(queryParameters:) emits a bare `password` with no `=` when
    // the value is empty, which the camera rejects. Build the query manually.
    final uri = Uri.parse('http://$ip/cgi-bin/api.cgi'
        '?cmd=${Uri.encodeQueryComponent(cmd)}'
        '&user=${Uri.encodeQueryComponent(username)}'
        '&password=${Uri.encodeQueryComponent(password)}');
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final req = await client.postUrl(uri);
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode([
        {'cmd': cmd, 'action': action, 'param': param}
      ]));
      final res = await req.close();
      final decoded = jsonDecode(await res.transform(utf8.decoder).join());
      return _unwrap(decoded);
    } finally {
      client.close();
    }
  }

  /// The web server needs a moment after HTTP is enabled before it accepts
  /// auth. Retry ONLY on connection-level failures — the camera locks the
  /// account after 10 failed logins, so a naive poll will lock it out.
  Future<bool> waitUntilReady({int maxAttempts = 4}) async {
    for (var i = 0; i < maxAttempts; i++) {
      try {
        final r = await call('GetDevInfo', {}, action: 1);
        if (r['code'] == 0) return true;
        final rsp = (r['error'] as Map?)?['rspCode'];
        // -7 bad credentials, -506 locked out: both are terminal, not transient
        if (rsp == -7 || rsp == -506) return false;
      } catch (_) {
        // connection refused / reset: service isn't listening yet, safe to retry
      }
      await Future.delayed(Duration(seconds: 2 * (i + 1)));
    }
    return false;
  }

  /// The camera uses two response shapes, sometimes for the same command:
  ///   bare array:  [ {cmd, code, value} ]
  ///   enveloped:   { "value": [ {cmd, code, value} ], "Count": 1 }
  /// Normalise both to the inner result object.
  static Map<String, dynamic> _unwrap(dynamic decoded) {
    if (decoded is List) {
      if (decoded.isEmpty) return <String, dynamic>{};
      return _unwrap(decoded.first);
    }
    if (decoded is Map<String, dynamic>) {
      if (!decoded.containsKey('code') && decoded['value'] is List) {
        return _unwrap(decoded['value']);
      }
      return decoded;
    }
    return <String, dynamic>{};
  }

  Future<bool> loginWorks() async {
    try {
      return (await call('GetDevInfo', {}, action: 1))['code'] == 0;
    } catch (_) {
      return false;
    }
  }

  /// Reolink MASKS several fields on read - not just passwords. A configured
  /// camera returns `cam-b*****1224a@lotiq.pro` for userName, `ft***er` for
  /// an FTP user. Same length, middle replaced by stars. So verification must
  /// treat `*` as a wildcard, or every correct write reports as a failure.
  static bool matchesMasked(dynamic got, dynamic want) {
    if (got == want) return true;
    final g = got?.toString() ?? '';
    final w = want?.toString() ?? '';
    if (!g.contains('*') || g.length != w.length) return false;
    for (var i = 0; i < g.length; i++) {
      if (g[i] != '*' && g[i] != w[i]) return false;
    }
    return true;
  }

  /// Apply FTP upload settings, then read back and diff.
  ///
  /// This build is V20-only: plain `SetFtp` returns "not support".
  Future<List<String>> applyFtp(FtpConfig cfg) async {
    final res = await call('SetFtpV20', {'Ftp': cfg.toJson()});
    if (res['code'] != 0) throw StateError('SetFtpV20 failed: $res');

    final after = await call('GetFtpV20', {'channel': 0}, action: 0);
    final live = ((after['value'] ?? {}) as Map)['Ftp'];
    if (live is! Map) return ['could not read FTP config back'];

    final problems = <String>[];
    void check(String key, dynamic want) {
      if (!matchesMasked(live[key], want)) {
        problems.add('$key = ${live[key]} (wanted $want)');
      }
    }

    check('server', cfg.server);
    check('port', cfg.port);
    check('userName', cfg.userName);
    check('remoteDir', cfg.remoteDir);
    check('streamType', cfg.streamType);
    check('enable', 1);
    // The three that default wrong and fail silently.
    check('mode', cfg.mode);
    check('onlyFtps', cfg.onlyFtps);

    final liveTable = (live['schedule'] as Map?)?['table'];
    if (liveTable is Map) {
      cfg.schedule.forEach((key, want) {
        if (liveTable[key] != want) {
          final onOff = want.contains('1') ? 'on' : 'off';
          problems.add('schedule.$key not set $onOff');
        }
      });
    } else {
      problems.add('could not read the upload schedule back');
    }
    return problems;
  }

  /// Ask the camera to self-test its FTP settings.
  ///
  /// ADVISORY ONLY - do not gate on this. On RLC-1224A firmware
  /// v3.2.0.5170 this returns rspCode -450 ("ftp test err") even when the
  /// camera is uploading perfectly: verified by finding camera-created date
  /// directories under remoteDir while TestFtp kept failing. The same
  /// behaviour is reported by other Reolink users on vsftpd.
  ///
  /// Real acceptance is "a file arrived", which this cannot tell you.
  Future<bool> testFtp() async {
    try {
      final res = await call('TestFtp', {});
      return res['code'] == 0;
    } catch (_) {
      return false;
    }
  }

  /// TRAP 4: ModifyUser with a plain `password` field returns rspCode 200 and
  /// is SILENTLY IGNORED. Must use newPassword + oldPassword, and success is
  /// not evidence — always verify with a fresh login.
  Future<void> setAdminPassword(String newPassword) async {
    final res = await call('ModifyUser', {
      'User': {
        'userName': username,
        'newPassword': newPassword,
        'oldPassword': password,
      }
    });
    if (res['code'] != 0) throw StateError('ModifyUser failed: $res');
    final verify = Cgi(ip, username: username, password: newPassword);
    if (!await verify.loginWorks()) {
      throw StateError('camera reported success but the new password does NOT work');
    }
  }
}

/// The full field flow, as the installer app runs it.
class Provisioner {
  final void Function(String) log;
  Provisioner({required this.log});

  Future<Discovered> run({
    required String scannedUid,
    required String newPassword,
    String currentPassword = '',
    FtpConfig? ftp,
    Map<String, dynamic>? config,
    String? subnet,
  }) async {
    // An empty newPassword silently BLANKS the camera's admin credential.
    // It even passes verification, because logging in with blank then works.
    // Caught in testing after a run reported PASS and left a camera open.
    if (newPassword.trim().isEmpty) {
      throw ArgumentError('newPassword cannot be empty - that would remove the '
          "camera's admin password entirely");
    }
    if (newPassword.length < 8) {
      throw ArgumentError('newPassword must be at least 8 characters');
    }
    if (!RegExp(r'^[A-Za-z0-9]+$').hasMatch(newPassword)) {
      throw ArgumentError('newPassword must be letters and digits only - '
          'symbols break URL query strings and shell quoting');
    }

    log('looking for $scannedUid');
    // findByUid now throws a FindFailure that says WHICH thing went wrong.
    final found = await Discovery.findByUid(scannedUid,
        password: currentPassword, subnet: subnet, onLog: log);

    final cam = BaichuanClient(found.ip, password: currentPassword);
    try {
      await cam.connect();
      await cam.login();
      final ports = await cam.getPorts();
      if (ports['http']?.enabled != true) {
        log('enabling http');
        await cam.setPortEnabled('http', true);
        if ((await cam.getPorts())['http']?.enabled != true) {
          throw StateError('http did not come up');
        }
      } else {
        log('http already enabled');
      }
    } finally {
      await cam.close();
    }

    final cgi = Cgi(found.ip, password: currentPassword);
    log('waiting for the web service to accept auth');
    if (!await cgi.waitUntilReady()) {
      throw StateError('CGI did not accept the current password. Either it is '
          'wrong, or the camera is locked out (10 failed logins, ~4 min).');
    }
    log('setting admin password');
    await cgi.setAdminPassword(newPassword);

    final live = Cgi(found.ip, password: newPassword);

    if (ftp != null) {
      log('applying FTP settings');
      final problems = await live.applyFtp(ftp);
      if (problems.isNotEmpty) {
        throw StateError('FTP settings did not stick: ${problems.join("; ")}');
      }
      // Advisory only. TestFtp reports failure on working cameras (see
      // Cgi.testFtp), so treating it as a gate fails cameras that are fine -
      // worse than no check, because it sends an installer chasing nothing.
      if (await live.testFtp()) {
        log('FTP self-test passed');
      } else {
        log('NOTE: the camera\'s FTP self-test did not pass. This is common on '
            'this firmware and does NOT mean uploads are broken. Confirm by '
            'checking that files appear under ${ftp.remoteDir}.');
      }
    }

    if (config != null) {
      for (final e in config.entries) {
        log('applying ${e.key}');
        final r = await live.call(e.key, e.value as Map<String, dynamic>);
        if (r['code'] != 0) throw StateError('${e.key} failed: $r');
      }
    }
    log('done');
    return found;
  }
}
