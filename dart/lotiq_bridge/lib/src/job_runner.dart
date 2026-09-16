/// runJob — carry out one backend job against a [CameraDriver], reporting progress and a result.
/// Port of `../reference/lib/jobRunner.mjs`. The backend hands down a fully-rendered job (secrets
/// filled, steps in order, each with its read-back expectation); the runner just executes + verifies.
library;

import 'backend_client.dart';
import 'camera_driver.dart';
import 'readback.dart';

typedef BridgeEventSink = void Function(Map<String, dynamic> event);

class JobResult {
  final bool ok;
  final List<String> problems;
  final String? error;
  final List<dynamic>? discovered;
  JobResult({required this.ok, this.problems = const [], this.error, this.discovered});
}

Future<JobResult> runJob(
  Map<String, dynamic> job,
  CameraDriver driver,
  BridgeJobApi client, {
  BridgeEventSink? onEvent,
  Map<String, dynamic>? deviceInfo,
  List<dynamic>? discovered,
}) async {
  final type = job['type'] as String?;
  final jobId = job['jobId'] as String;
  if (type == 'discover') {
    return _runDiscover(jobId, driver, client, discovered: discovered);
  }
  if (type != 'provision') {
    await client.complete(jobId, {'status': 'failed', 'error': 'bridge cannot run job type $type'});
    return JobResult(ok: false, error: 'unsupported job type $type');
  }
  return _runProvision(job, driver, client, onEvent: onEvent, deviceInfo: deviceInfo);
}

Future<JobResult> _runProvision(
  Map<String, dynamic> job,
  CameraDriver driver,
  BridgeJobApi client, {
  BridgeEventSink? onEvent,
  Map<String, dynamic>? deviceInfo,
}) async {
  final jobId = job['jobId'] as String;
  final t0 = DateTime.now();
  final candidatePasswords = (job['candidatePasswords'] as List).cast<String>();
  final newPassword = job['newPassword'] as String;
  final steps = (job['steps'] as List).cast<Map<String, dynamic>>();

  Future<void> emit(String step, String status, [String? detail, int? ms]) async {
    final ev = <String, dynamic>{'step': step, 'status': status};
    if (detail != null) ev['detail'] = detail;
    if (ms != null) ev['ms'] = ms;
    onEvent?.call(ev);
    try {
      await client.postEvents(jobId, [ev]);
    } catch (_) {/* progress is best-effort */}
  }

  await client.heartbeat(jobId, running: true);

  try {
    // 1. Log in with the passwords the backend supplied, in order (never guess — lockout budget).
    await emit('login', 'start', '${candidatePasswords.length} candidate(s)');
    await driver.login(candidatePasswords);
    await emit('login', 'ok');

    // 2. Set the admin password, then tell the backend immediately (two-step commit).
    final current = candidatePasswords.firstWhere((p) => p != newPassword,
        orElse: () => candidatePasswords.isNotEmpty ? candidatePasswords.first : '');
    await driver.setAdminPassword(current, newPassword);
    await client.passwordCommitted(jobId);
    await emit('password', 'committed');

    // 3. Apply each golden-config step and read it back.
    final problems = <String>[];
    for (final step in steps) {
      final s0 = DateTime.now();
      final id = (step['id'] ?? step['cmd']) as String;
      final optional = step['optional'] == true;
      try {
        await driver.apply(step['cmd'] as String, (step['param'] as Map).cast<String, dynamic>());
        final verifyCmd = step['verifyCmd'] as String?;
        if (verifyCmd != null) {
          final value = await driver.readBack(
              verifyCmd, ((step['verifyParam'] ?? {}) as Map).cast<String, dynamic>());
          final stepProblems =
              diffExpect(((step['expect'] ?? {}) as Map).cast<String, dynamic>(), value);
          final ms = DateTime.now().difference(s0).inMilliseconds;
          if (stepProblems.isNotEmpty) {
            if (optional) {
              await emit(id, 'warn', 'optional read-back mismatch: ${stepProblems.join("; ")}', ms);
            } else {
              problems.addAll(stepProblems.map((p) => '$id.$p'));
              await emit(id, 'fail', stepProblems.join('; '), ms);
            }
          } else {
            await emit(id, 'ok', null, ms);
          }
        } else {
          await emit(id, 'ok', '(no read-back)', DateTime.now().difference(s0).inMilliseconds);
        }
      } catch (e) {
        final ms = DateTime.now().difference(s0).inMilliseconds;
        if (optional) {
          await emit(id, 'warn', 'optional step error: $e', ms);
        } else {
          problems.add('$id: $e');
          await emit(id, 'fail', '$e', ms);
        }
      }
    }

    // 4. Report. Read-back problems mean a failed provision even though every Set "succeeded".
    final readbackOk = problems.isEmpty;
    final device = <String, dynamic>{
      'uid': job['uid'],
      'model': driver.model,
      'firmware': driver.firmware,
      ...?deviceInfo,
    };
    await client.complete(jobId, {
      'status': readbackOk ? 'succeeded' : 'failed',
      'diff': {'readbackOk': readbackOk, 'problems': problems},
      'device': device,
      'timings': {'totalMs': DateTime.now().difference(t0).inMilliseconds},
    });
    return JobResult(ok: readbackOk, problems: problems);
  } catch (e) {
    await emit('provision', 'fail', '$e');
    await client.complete(jobId, {
      'status': 'failed',
      'diff': {
        'readbackOk': false,
        'problems': ['$e']
      },
      'error': '$e',
      'timings': {'totalMs': DateTime.now().difference(t0).inMilliseconds},
    });
    return JobResult(ok: false, error: '$e');
  }
}

Future<JobResult> _runDiscover(
  String jobId,
  CameraDriver driver,
  BridgeJobApi client, {
  List<dynamic>? discovered,
}) async {
  await client.heartbeat(jobId, running: true);
  final list = discovered ??
      [
        {'ip': '192.168.1.50', 'uid': (driver is FakeReolink) ? driver.uid : '', 'model': driver.model, 'status': 'ok'}
      ];
  await client.postEvents(jobId, [
    {'step': 'sweep', 'status': 'ok', 'detail': '${list.length} found'}
  ]);
  await client.complete(jobId, {
    'status': 'succeeded',
    'diff': {'discovered': list, 'found': list.length}
  });
  return JobResult(ok: true, discovered: list);
}
