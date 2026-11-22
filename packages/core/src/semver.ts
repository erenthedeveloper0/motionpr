/**
 * Minimal semver range check for adapter version reporting. Supports comparator sets such as
 * `>=4.0.0 <5.0.0`, `^3.12.0`, `~1.3.0`, exact versions and `||` alternatives. Pre-release tags
 * compare lower than the release, as in semver. Not a general-purpose implementation.
 */
type Triple = [number, number, number, string];

function parse(version: string): Triple | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ?? ""];
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  if (a[3] === b[3]) return 0;
  if (!a[3]) return 1;
  if (!b[3]) return -1;
  return a[3] < b[3] ? -1 : 1;
}

function comparator(token: string, v: Triple): boolean {
  const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
  if (!m) return false;
  const target = parse(m[2]!);
  if (!target) return false;
  const c = compare(v, target);
  switch (m[1]) {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    case "^": {
      const upper: Triple = target[0] > 0 ? [target[0] + 1, 0, 0, ""] : [0, target[1] + 1, 0, ""];
      return c >= 0 && compare(v, upper) < 0;
    }
    case "~":
      return c >= 0 && compare(v, [target[0], target[1] + 1, 0, ""]) < 0;
    default:
      return c === 0;
  }
}

/** True when every comparator of `range` parses (`>=4.0.0 <5.0.0`, `^3.12.0`, `1.x || 2.x` does not). */
export function isVersionRange(range: string): boolean {
  const sets = range.split("||").map((set) => set.trim().split(/\s+/).filter(Boolean));
  return (
    sets.length > 0 &&
    sets.every(
      (tokens) =>
        tokens.length > 0 &&
        tokens.every((token) => {
          const m = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(token);
          return m !== null && parse(m[2]!) !== null;
        }),
    )
  );
}

/** True when `version` satisfies `range`. Unparseable versions never satisfy. */
export function versionSatisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split("||").some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => comparator(token, v)),
  );
}
