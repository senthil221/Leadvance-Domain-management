import { describe, expect, it } from "vitest";
import { autoRenewOf, expiryLabel, expiryTone, isExpiryTracked, isWithin, needsAction } from "../src/lib/expiring";

describe("which domains the Expiring tab lists", () => {
  it("lists domains in use that are past their date, close to it, or have no date", () => {
    for (const status of ["active", "warming", "provisioning"] as const) {
      expect(isExpiryTracked({ status, daysToExpiry: -5 })).toBe(true);
      expect(isExpiryTracked({ status, daysToExpiry: 90 })).toBe(true);
      expect(isExpiryTracked({ status, daysToExpiry: null })).toBe(true);
    }
    expect(isExpiryTracked({ status: "active", daysToExpiry: 91 })).toBe(false);
  });

  it("leaves out domains not in use", () => {
    for (const status of ["in_storage", "draining", "burned", "resting"] as const) expect(isExpiryTracked({ status, daysToExpiry: 3 })).toBe(false);
  });

  it("keeps an expired domain in every window, and one with no date in none", () => {
    expect(isWithin({ status: "active", daysToExpiry: -30 }, 7)).toBe(true);
    expect(isWithin({ status: "active", daysToExpiry: 7 }, 7)).toBe(true);
    expect(isWithin({ status: "active", daysToExpiry: 8 }, 7)).toBe(false);
    expect(isWithin({ status: "active", daysToExpiry: null }, 90)).toBe(false);
  });
});

describe("what it says about each one", () => {
  it("words the time left", () => {
    expect([-2, -1, 0, 1, 12, null].map(expiryLabel)).toEqual(["Expired 2d ago", "Expired 1d ago", "Expires today", "1 day", "12 days", "No date"]);
  });

  it("gets louder as the date gets close", () => {
    expect([-1, 7, 8, 30, 31, null].map(expiryTone)).toEqual(["danger", "danger", "warning", "warning", "neutral", "faint"]);
  });

  it("only trusts auto-renew when the registrar says it's on", () => {
    expect([true, false, null].map((v) => autoRenewOf(v).label)).toEqual(["On", "Off", "Not known"]);
    expect(needsAction({ autoRenew: true, replacedById: null })).toBe(false);
    expect(needsAction({ autoRenew: false, replacedById: null })).toBe(true);
    expect(needsAction({ autoRenew: null, replacedById: null })).toBe(true);
  });

  it("stops asking once a replacement has started", () => {
    expect(needsAction({ autoRenew: false, replacedById: "new-domain" })).toBe(false);
  });
});
