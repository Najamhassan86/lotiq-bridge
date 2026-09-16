import 'package:lotiq_bridge/src/readback.dart';
import 'package:test/test.dart';

void main() {
  group('matchesMasked', () {
    test('exact, masked, numeric-string, and mismatches', () {
      expect(matchesMasked('ftp.lotiq.pro', 'ftp.lotiq.pro'), isTrue);
      expect(matchesMasked('ft***er', 'ftpuser'), isTrue);
      expect(matchesMasked('cam-b*****1224a@lotiq.pro', 'cam-bench-1224a@lotiq.pro'), isTrue);
      expect(matchesMasked(21, '21'), isTrue);
      expect(matchesMasked('2', 2), isTrue);
      expect(matchesMasked('ft***er', 'ftpusers'), isFalse); // length differs
      expect(matchesMasked('fa***er', 'ftpuser'), isFalse); // unmasked char differs
      expect(matchesMasked(null, 'x'), isFalse);
      expect(matchesMasked(0, 2), isFalse);
    });
  });

  test('getPath walks maps and lists', () {
    final v = {
      'Ftp': {
        'schedule': {
          'table': {'TIMING': '111'}
        },
        'ports': [21, 40000]
      }
    };
    expect(getPath(v, 'Ftp.schedule.table.TIMING'), '111');
    expect(getPath(v, 'Ftp.ports.1'), 40000);
    expect(getPath(v, 'Ftp.missing.deeper'), isNull);
    expect(getPath(null, 'a'), isNull);
  });

  test('diffExpect reports mismatches and honours the * wildcard', () {
    final value = {
      'Ftp': {
        'server': '61637.ftp.stg.lotiq.pro',
        'port': 21,
        'mode': 0,
        'onlyFtps': 1,
        'userName': '61***b',
        'password': '******'
      }
    };
    final problems = diffExpect({
      'Ftp.server': '61637.ftp.stg.lotiq.pro',
      'Ftp.port': 21,
      'Ftp.mode': 2,
      'Ftp.onlyFtps': 0,
      'Ftp.userName': '61637-cam-7f3a9c2b',
      'Ftp.password': '*',
      'Ftp.autoDir': 1,
    }, value);
    expect(problems.map((p) => p.split(':').first),
        containsAll(['Ftp.mode', 'Ftp.onlyFtps', 'Ftp.userName', 'Ftp.autoDir']));
    expect(problems.length, 4);
  });

  test('diffExpect passes a faithful read-back', () {
    final problems = diffExpect({'Time.timeZone': 18000, 'Dst.enable': 1}, {
      'Time': {'timeZone': 18000},
      'Dst': {'enable': 1}
    });
    expect(problems, isEmpty);
  });
}
