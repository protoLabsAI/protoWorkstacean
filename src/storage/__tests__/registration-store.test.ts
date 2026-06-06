import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistrationStore } from "../registration-store.ts";

const dirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "reg-store-"));
  dirs.push(d);
  return join(d, "registrations.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("RegistrationStore", () => {
  test("upsert + all round-trips by kind", () => {
    const s = new RegistrationStore(tmpDb());
    s.upsert("a2a", "roxy", "name: roxy\nurl: http://roxy:7870\n");
    s.upsert("a2a", "jon", "name: jon\n");
    s.upsert("mcp", "fs", "name: fs\n");

    const a2a = s.all("a2a");
    expect(a2a.map((r) => r.name)).toEqual(["jon", "roxy"]); // ORDER BY name
    expect(a2a.find((r) => r.name === "roxy")!.yaml).toContain("roxy:7870");
    expect(s.all("mcp").map((r) => r.name)).toEqual(["fs"]);
    s.close();
  });

  test("upsert replaces existing yaml (idempotent register)", () => {
    const s = new RegistrationStore(tmpDb());
    s.upsert("a2a", "roxy", "name: roxy\nv: 1\n");
    s.upsert("a2a", "roxy", "name: roxy\nv: 2\n");
    expect(s.all("a2a")).toHaveLength(1);
    expect(s.all("a2a")[0].yaml).toContain("v: 2");
    s.close();
  });

  test("remove forgets a registration", () => {
    const s = new RegistrationStore(tmpDb());
    s.upsert("a2a", "roxy", "name: roxy\n");
    s.remove("a2a", "roxy");
    expect(s.all("a2a")).toEqual([]);
    s.close();
  });

  test("survives reopen (the whole point — durable across process restarts)", () => {
    const path = tmpDb();
    const s1 = new RegistrationStore(path);
    s1.upsert("a2a", "roxy", "name: roxy\n");
    s1.close();

    const s2 = new RegistrationStore(path);
    expect(s2.all("a2a").map((r) => r.name)).toEqual(["roxy"]);
    s2.close();
  });

  test("remove of an absent key is a no-op", () => {
    const s = new RegistrationStore(tmpDb());
    s.remove("a2a", "nope"); // must not throw
    expect(s.all("a2a")).toEqual([]);
    s.close();
  });
});
