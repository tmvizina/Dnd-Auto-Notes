/**
 * Craig names its tracks `<index>-<username>[_<discriminator>].<ext>`. The
 * username half is a Discord display name, so it can contain anything a person
 * can type — spaces, emoji, underscores, other hyphens. Parsing therefore
 * degrades rather than fails: a name we cannot read still yields a track bound
 * to its raw stem, because losing a whole participant to a regex is far worse
 * than losing their index.
 */

/** Extensions Craig actually emits, plus wav for the synthetic fixture. */
export const TRACK_EXTENSIONS = Object.freeze([
  ".flac",
  ".aac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
] as const);

export type TrackExtension = (typeof TRACK_EXTENSIONS)[number];

export function isTrackFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return TRACK_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface CraigName {
  /** Craig's 1-based track number, or null when the stem does not start with one. */
  readonly index: number | null;
  /** Display name with the discriminator removed. Never empty — falls back to the stem. */
  readonly username: string;
  /** Legacy Discord discriminator, digits only. Absent under the new username system. */
  readonly discriminator: string | null;
  /** The filename with its extension removed, exactly as it appeared. */
  readonly stem: string;
  /**
   * Set when the stem did not match the convention. The caller turns this into
   * a QA warning; it is never a reason to drop the track.
   */
  readonly warning: string | null;
}

/**
 * A discriminator is the legacy `name#1234` tail that Craig writes with an
 * underscore. Only digits qualify: `cyd_h` is a username containing an
 * underscore, not `cyd` with a discriminator of `h`, and treating it as the
 * latter would unbind a real player.
 */
const DISCRIMINATOR = /[_#-](\d{4,6})$/;

/** Craig separates index from name with `-`, but a hand-renamed file may use `_` or a space. */
const INDEXED = /^(\d{1,4})\s*[-_ ]\s*(.*)$/s;

export function stemOf(filename: string): string {
  const lower = filename.toLowerCase();
  const extension = TRACK_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return extension === undefined ? filename : filename.slice(0, -extension.length);
}

export function parseCraigName(filename: string): CraigName {
  const stem = stemOf(filename);
  const trimmed = stem.trim();

  const indexed = INDEXED.exec(trimmed);
  const index = indexed === null ? null : Number.parseInt(indexed[1] ?? "", 10);
  const remainder = (indexed === null ? trimmed : (indexed[2] ?? "")).trim();

  const discriminatorMatch = DISCRIMINATOR.exec(remainder);
  const discriminator = discriminatorMatch?.[1] ?? null;
  const withoutDiscriminator =
    discriminatorMatch === null
      ? remainder
      : remainder.slice(0, remainder.length - discriminatorMatch[0].length).trim();

  // Falling back to the stem keeps a nameless track matchable by hand later;
  // an empty username would make it invisible in the review UI.
  const username = withoutDiscriminator === "" ? trimmed : withoutDiscriminator;

  let warning: string | null = null;
  if (indexed === null) {
    warning = "no leading track index";
  } else if (withoutDiscriminator === "") {
    warning = "no username after the track index";
  } else if (Number.isNaN(index) || index === null) {
    warning = "track index is not a number";
  }

  return {
    index: index === null || Number.isNaN(index) ? null : index,
    username: username === "" ? stem : username,
    discriminator,
    stem,
    warning,
  };
}
