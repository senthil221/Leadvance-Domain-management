import { timingSafeEqual } from "node:crypto";

/** The Google Sheet feeds are keyed by SHEET_SYNC_TOKEN, compared in constant time. */
export function sheetTokenOk(given: string) {
  const expected = process.env.SHEET_SYNC_TOKEN ?? "";
  if (expected.length < 16 || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
