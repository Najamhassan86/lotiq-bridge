/// Read-back comparison — the Dart twin of the Node reference's `masking.mjs` and the backend's
/// `readback.js`. Keep all three in step.
///
/// The camera masks the middle of several fields on read (a configured unit returns `ft***er` for an
/// FTP user, same length, stars in the middle), so an equality check would fail every correct write.
/// A `*` in the read value is a wildcard for that position; an expected value of `"*"` (used for
/// passwords) means "present, don't compare".
library;

bool matchesMasked(dynamic got, dynamic want) {
  if (got == want) return true;
  if (got == null || want == null) return false;
  final g = got.toString();
  final w = want.toString();
  if (g == w) return true;
  if (!g.contains('*') || g.length != w.length) return false;
  for (var i = 0; i < g.length; i++) {
    if (g[i] != '*' && g[i] != w[i]) return false;
  }
  return true;
}

/// Dotted-path lookup into decoded JSON (maps + lists). Returns null when any segment is missing.
dynamic getPath(dynamic obj, String path) {
  dynamic cur = obj;
  for (final seg in path.split('.')) {
    if (cur is Map) {
      cur = cur[seg];
    } else if (cur is List) {
      final idx = int.tryParse(seg);
      cur = (idx != null && idx >= 0 && idx < cur.length) ? cur[idx] : null;
    } else {
      return null;
    }
  }
  return cur;
}

/// Compare an `expect` map against a camera read-back `value`; returns the list of mismatches.
List<String> diffExpect(Map<String, dynamic> expect, dynamic value) {
  final problems = <String>[];
  expect.forEach((path, want) {
    final got = getPath(value, path);
    if (want == '*') {
      if (got == null) problems.add('$path: missing');
      return;
    }
    if (!matchesMasked(got, want)) {
      problems.add('$path: got ${_j(got)} want ${_j(want)}');
    }
  });
  return problems;
}

String _j(dynamic v) => v is String ? '"$v"' : '$v';
