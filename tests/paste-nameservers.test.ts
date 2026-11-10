import { describe, expect, it } from "vitest";
import { parseNameserverSheet } from "../src/lib/paste-nameservers";

// Made-up domains only.
describe("parseNameserverSheet", () => {
  it("reads a sheet copied from Excel, header and all", () => {
    const text = "Domain\tRequired Nameserver 1\tRequired Nameserver 2\nExampleOne.info\tcarl.ns.cloudflare.com\ttani.ns.cloudflare.com\r\nexampletwo.info\tjasmine.ns.cloudflare.com\tsean.ns.cloudflare.com\n\n";
    const r = parseNameserverSheet(text);
    expect(r.problems).toEqual([]);
    expect(r.rows).toEqual([
      { domain: "exampleone.info", nameservers: ["carl.ns.cloudflare.com", "tani.ns.cloudflare.com"] },
      { domain: "exampletwo.info", nameservers: ["jasmine.ns.cloudflare.com", "sean.ns.cloudflare.com"] },
    ]);
  });

  it("takes commas or spaces, trailing dots and links", () => {
    const r = parseNameserverSheet("https://examplethree.com/, a.ns.example.net., b.ns.example.net\nexamplefour.com a.ns.example.net b.ns.example.net c.ns.example.net");
    expect(r.rows.map((x) => [x.domain, x.nameservers.length])).toEqual([["examplethree.com", 2], ["examplefour.com", 3]]);
    expect(r.rows[0].nameservers).toEqual(["a.ns.example.net", "b.ns.example.net"]);
  });

  it("says which lines it can't use", () => {
    const r = parseNameserverSheet("examplefive.com\tonly.ns.example.net\nexamplesix.com\nnot a domain at all a.ns.example.net b.ns.example.net");
    expect(r.rows).toEqual([]);
    expect(r.problems.map((p) => [p.line, p.why])).toEqual([[1, "Only one nameserver"], [2, "No nameservers"], [3, "Doesn't start with a domain"]]);
  });

  it("keeps the last line when a domain comes twice", () => {
    const r = parseNameserverSheet("exampleseven.com a.ns.x.net b.ns.x.net\nexampleseven.com c.ns.x.net d.ns.x.net");
    expect(r.rows).toEqual([{ domain: "exampleseven.com", nameservers: ["c.ns.x.net", "d.ns.x.net"] }]);
  });
});
