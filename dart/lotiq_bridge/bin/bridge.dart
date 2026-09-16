/// CLI harness for the bridge (bench + support use). Drives the same package the Flutter app does.
///
///   dart run bin/bridge.dart --url https://... --code 123456 [--subnet 192.168.1] [--fake]
///
/// `--fake` runs against an in-memory FakeReolink (no camera), useful to smoke the pairing + job
/// contract from a laptop. Without it, discovery finds the real camera by the job's UID on the LAN.
library;

import 'dart:io';

import 'package:lotiq_bridge/lotiq_bridge.dart';

Future<void> main(List<String> args) async {
  final opts = _parse(args);
  final url = opts['url'];
  final code = opts['code'];
  if (url == null || code == null) {
    stderr.writeln('usage: dart run bin/bridge.dart --url <backend> --code <6-digit> [--subnet x.y.z] [--fake]');
    exit(2);
  }
  final fake = opts.containsKey('fake');
  final subnet = opts['subnet'];

  final summary = await runBridge(
    baseUrl: url,
    pairCode: code,
    subnet: subnet,
    platform: Platform.operatingSystem,
    appVersion: 'cli-0.1.0',
    maxIdlePolls: fake ? 3 : 0,
    log: stdout.writeln,
    makeDriver: (job) async {
      if (fake) {
        return FakeReolink(uid: (job['uid'] as String?) ?? 'FAKEUID');
      }
      // Real path: find the camera by UID on the LAN, then build a CGI driver. HTTP-enable over
      // Baichuan happens inside the discovery/enable flow; see the installer app for the full glue.
      final uid = job['uid'] as String;
      final found = await Discovery.findByUid(uid, password: '', subnet: subnet, onLog: stdout.writeln);
      return ReolinkDriver(found.ip, model: found.model ?? '', firmware: '');
    },
  );

  stdout.writeln('done — session ${summary.session['sessionId']}, ran ${summary.ran.length} job(s)');
}

Map<String, String> _parse(List<String> args) {
  final out = <String, String>{};
  for (var i = 0; i < args.length; i++) {
    final a = args[i];
    if (a.startsWith('--')) {
      final key = a.substring(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        out[key] = args[++i];
      } else {
        out[key] = 'true';
      }
    }
  }
  return out;
}
