/**
 * Read-back comparison — must match lotiq-backend/src/provisioning/readback.js byte-for-byte, and
 * the Dart port's equivalent. The camera masks the middle of several fields on read (a configured
 * unit returns `ft***er` for an FTP user, same length, stars in the middle), so an equality check
 * would fail every correct write. `*` in the read value is a wildcard for that position; an expected
 * value of `"*"` (used for passwords) means "present, don't compare".
 */
export function matchesMasked(got, want) {
  if (got === want) return true;
  if (got == null || want == null) return false;
  const g = String(got);
  const w = String(want);
  if (g === w) return true;
  if (!g.includes("*") || g.length !== w.length) return false;
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== "*" && g[i] !== w[i]) return false;
  }
  return true;
}

export function getPath(obj, path) {
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Compare an `expect` map against a camera read-back `value`. */
export function diffExpect(expect, value) {
  const problems = [];
  for (const [path, want] of Object.entries(expect || {})) {
    const got = getPath(value, path);
    if (want === "*") {
      if (got === undefined) problems.push(`${path}: missing`);
      continue;
    }
    if (!matchesMasked(got, want)) problems.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
  return problems;
}
