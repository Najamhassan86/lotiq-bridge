/**
 * Read-back comparison — the TS twin of the backend's readback.js and the Node reference's
 * masking.mjs. The camera masks the middle of several fields on read (`ft***er`), so `*` in the read
 * value is a wildcard for that position; an expected `"*"` (passwords) means "present, don't compare".
 */
export function matchesMasked(got: unknown, want: unknown): boolean {
  if (got === want) return true;
  if (got == null || want == null) return false;
  const g = String(got);
  const w = String(want);
  if (g === w) return true;
  if (!g.includes('*') || g.length !== w.length) return false;
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== '*' && g[i] !== w[i]) return false;
  }
  return true;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else {
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

export function diffExpect(expect: Record<string, unknown>, value: unknown): string[] {
  const problems: string[] = [];
  for (const [path, want] of Object.entries(expect || {})) {
    const got = getPath(value, path);
    if (want === '*') {
      if (got === undefined) problems.push(`${path}: missing`);
      continue;
    }
    if (!matchesMasked(got, want)) {
      problems.push(`${path}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  return problems;
}
