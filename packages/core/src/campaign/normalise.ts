/**
 * Name normalisation for *matching only*. Display always uses the original —
 * a player called "Bly" should never be shown as "bly" because the matcher
 * folded it.
 */

/** Discord discriminators ("name#1234") and bot suffixes are noise for matching. */
const DISCRIMINATOR = /#\d{2,6}$/;

export function normaliseName(value: string): string {
  return (
    value
      .normalize("NFKD")
      // Strip the combining marks NFKD just split off, so "Sére" and "Sere" match.
      .replace(/\p{Mark}+/gu, "")
      .replace(DISCRIMINATOR, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
      .trim()
      .replace(/\s+/g, " ")
  );
}

export function nameTokens(value: string): string[] {
  const normalised = normaliseName(value);
  return normalised === "" ? [] : normalised.split(" ");
}

/** Levenshtein distance, iterative with a single row — no dependency needed. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Partial evidence never reaches 1. A score of exactly 1 has to mean the two
 * names normalise to the same string, so callers can use it as an exactness
 * test — an identical *token* inside two different names must not qualify.
 */
const PARTIAL_CEILING = 0.95;

/**
 * 0..1 similarity combining whole-string edit distance with token overlap, so
 * "Ash B." and "ashcodes" score on their shared first token rather than being
 * punished for the parts that differ.
 */
export function similarity(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  if (left === "" || right === "") return 0;
  if (left === right) return 1;

  const distance = editDistance(left, right);
  const whole = 1 - distance / Math.max(left.length, right.length);

  const leftTokens = new Set(nameTokens(a));
  const rightTokens = new Set(nameTokens(b));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const overlap = shared / Math.max(leftTokens.size, rightTokens.size);

  // A shared prefix is good evidence for usernames derived from a name
  // ("ash" -> "ashcodes"). Scaled by how much of the longer string it covers:
  // a flat bonus here outranks genuinely closer full-string matches.
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const prefix =
    longer.startsWith(shorter) && shorter.length >= 3
      ? Math.min(PARTIAL_CEILING, 0.6 + 0.4 * (shorter.length / longer.length))
      : 0;

  // Token-level prefix: "Ash B." vs "ashcodes" shares the stem "ash", which
  // whole-string comparison cannot see because the rest diverges. This is the
  // usual shape of a Discord handle derived from a name.
  let tokenPrefix = 0;
  for (const a of leftTokens) {
    for (const b of rightTokens) {
      const short = a.length <= b.length ? a : b;
      const long = a.length <= b.length ? b : a;
      if (short.length >= 3 && long.startsWith(short)) {
        tokenPrefix = Math.max(
          tokenPrefix,
          Math.min(PARTIAL_CEILING, 0.6 + 0.4 * (short.length / long.length)),
        );
      }
    }
  }

  return Math.max(whole, overlap, prefix, tokenPrefix);
}
