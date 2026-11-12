import { timingSafeEqual } from "node:crypto";

/**
 * A token from a URL against the one in the environment, in constant time.
 * Compared as bytes, so a token with other characters in it is a plain no
 * rather than an error.
 */
export function tokenMatches(given: string, expected: string | undefined, minLength = 1) {
  if (!expected || expected.length < minLength) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The Google Sheet feeds are keyed by SHEET_SYNC_TOKEN. */
export const sheetTokenOk = (given: string) => tokenMatches(given, process.env.SHEET_SYNC_TOKEN, 16);
