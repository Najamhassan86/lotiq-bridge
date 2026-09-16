import 'package:lotiq_bridge/src/backend_client.dart';
import 'package:lotiq_bridge/src/camera_driver.dart';
import 'package:lotiq_bridge/src/job_runner.dart';
import 'package:test/test.dart';

/// Captures what the bridge would POST, no network.
class FakeApi implements BridgeJobApi {
  final events = <Map<String, dynamic>>[];
  bool committed = false;
  Map<String, dynamic>? completed;

  @override
  Future<void> heartbeat(String jobId, {bool running = false}) async {}
  @override
  Future<void> postEvents(String jobId, List<Map<String, dynamic>> evs) async => events.addAll(evs);
  @override
  Future<void> passwordCommitted(String jobId) async => committed = true;
  @override
  Future<Map<String, dynamic>> complete(String jobId, Map<String, dynamic> body) async {
    completed = body;
    return {'ok': true};
  }
}

Map<String, dynamic> _job() => {
      'jobId': 'job#test',
      'type': 'provision',
      'uid': '9527000LG03YBYGG',
      'deviceName': '61637-cam-demo',
      'newPassword': 'Kt8mQ2vXpL4nR7cW9bZ3jF6h',
      'candidatePasswords': [''],
      'steps': [
        {
          'id': 'time',
          'cmd': 'SetTime',
          'verifyCmd': 'GetTime',
          'param': {
            'Time': {'timeZone': 18000}
          },
          'expect': {'Time.timeZone': 18000}
        },
        {
          'id': 'ftp',
          'cmd': 'SetFtpV20',
          'verifyCmd': 'GetFtpV20',
          'param': {
            'Ftp': {
              'enable': 1,
              'server': '61637.ftp.stg.lotiq.pro',
              'userName': '61637-cam-demo',
              'password': 's3cret',
              'mode': 2,
              'onlyFtps': 0
            }
          },
          'expect': {
            'Ftp.enable': 1,
            'Ftp.server': '61637.ftp.stg.lotiq.pro',
            'Ftp.userName': '61637-cam-demo',
            'Ftp.password': '*',
            'Ftp.mode': 2,
            'Ftp.onlyFtps': 0
          }
        }
      ]
    };

void main() {
  test('healthy camera → succeeded, password committed', () async {
    final api = FakeApi();
    final result = await runJob(_job(), FakeReolink(uid: '9527000LG03YBYGG'), api);
    expect(result.ok, isTrue);
    expect(api.committed, isTrue);
    expect(api.completed!['status'], 'succeeded');
    // login + password + one event per step
    expect(api.events.where((e) => e['status'] == 'ok').length, greaterThanOrEqualTo(3));
  });

  test('camera that silently ignores FTP mode (trap 4) → failed, read-back catches it', () async {
    final api = FakeApi();
    final result =
        await runJob(_job(), FakeReolink(uid: '9527000LG03YBYGG', ignoreFtpMode: true), api);
    expect(result.ok, isFalse);
    expect(api.completed!['status'], 'failed');
    expect(result.problems.any((p) => p.contains('mode')), isTrue);
  });

  test('ModifyUser with the wrong current password fails the job', () async {
    final api = FakeApi();
    // Camera already has a non-blank password, but the job only offers the blank one.
    final result = await runJob(_job(), FakeReolink(uid: 'x', password: 'SomethingElse1'), api);
    expect(result.ok, isFalse);
    expect(api.completed!['status'], 'failed');
  });
}
