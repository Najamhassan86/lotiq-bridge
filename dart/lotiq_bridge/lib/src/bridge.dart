/// The bridge loop: pair once, then poll for jobs and run each until the session ends. Port of
/// `../reference/lib/bridge.mjs`. In the Flutter app this runs on a foreground isolate while the
/// screen is kept awake; here it is a plain async loop.
library;

import 'backend_client.dart';
import 'camera_driver.dart';
import 'job_runner.dart';

typedef DriverFactory = Future<CameraDriver> Function(Map<String, dynamic> job);

class BridgeRunSummary {
  final Map<String, dynamic> session;
  final List<Map<String, dynamic>> ran;
  BridgeRunSummary(this.session, this.ran);
}

Future<BridgeRunSummary> runBridge({
  required String baseUrl,
  required String pairCode,
  required DriverFactory makeDriver,
  String? platform,
  String? appVersion,
  String? subnet,
  Duration pollInterval = const Duration(milliseconds: 1500),
  int maxIdlePolls = 0,
  void Function(String message)? log,
  BridgeBackendClient? client,
}) async {
  final c = client ?? BridgeBackendClient(baseUrl);
  void say(String m) => log?.call(m);

  final paired = await c.pair(pairCode, platform: platform, appVersion: appVersion, subnet: subnet);
  final session = (paired['session'] as Map).cast<String, dynamic>();
  say('paired to session ${session['sessionId']} for property ${session['propertyId']}');

  var idle = 0;
  final ran = <Map<String, dynamic>>[];
  while (true) {
    Map<String, dynamic> next;
    try {
      next = await c.nextJob(subnet: subnet);
    } on BridgeException catch (e) {
      if (e.status == 401) {
        say('session no longer active — stopping');
        break;
      }
      rethrow;
    }
    final job = next['job'];
    if (job == null) {
      idle += 1;
      if (maxIdlePolls > 0 && idle >= maxIdlePolls) break;
      await Future<void>.delayed(pollInterval);
      continue;
    }
    idle = 0;
    final jobMap = (job as Map).cast<String, dynamic>();
    say('running ${jobMap['type']} job ${jobMap['jobId']}'
        '${jobMap['uid'] != null ? ' (uid ${jobMap['uid']})' : ''}');
    final driver = await makeDriver(jobMap);
    final result = await runJob(jobMap, driver, c,
        onEvent: (e) => say('  ${e['step']}: ${e['status']}'
            '${e['detail'] != null ? ' — ${e['detail']}' : ''}'));
    ran.add({'jobId': jobMap['jobId'], 'type': jobMap['type'], 'result': result});
    say('  -> ${result.ok ? 'ok' : 'FAILED'}'
        '${result.problems.isNotEmpty ? ': ${result.problems.join("; ")}' : ''}');
  }
  return BridgeRunSummary(session, ran);
}
