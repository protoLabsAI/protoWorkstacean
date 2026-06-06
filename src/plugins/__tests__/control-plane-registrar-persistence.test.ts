/**
 * Durable a2a registrations (#850): a registration made via the control-plane
 * API must survive a redeploy that wipes the ephemeral agents.d/ clone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlPlaneRegistrarPlugin } from "../control-plane-registrar-plugin.ts";
import { RegistrationStore } from "../../storage/registration-store.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";

const roots: string[] = [];
function scratch() {
  const base = mkdtempSync(join(tmpdir(), "cpr-"));
  roots.push(base);
  const workspace = join(base, "workspace");
  mkdirSync(join(workspace, "agents.d"), { recursive: true });
  return { workspace, dbPath: join(base, "registrations.db"), agentsd: join(workspace, "agents.d") };
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function upsert(bus: InMemoryEventBus, name: string, file: string, yaml: string) {
  bus.publish("command.a2a.upsert", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "command.a2a.upsert",
    timestamp: 0,
    payload: { name, file, yaml },
  });
}

describe("ControlPlaneRegistrar — durable a2a registrations", () => {
  test("upsert writes agents.d/ AND persists to the store", () => {
    const { workspace, dbPath, agentsd } = scratch();
    const store = new RegistrationStore(dbPath);
    const bus = new InMemoryEventBus();
    const reg = new ControlPlaneRegistrarPlugin(workspace, store);
    reg.install(bus);
    const file = join(agentsd, "roxy.yaml");
    upsert(bus, "roxy", file, "name: roxy\nurl: http://roxy:7870\n");

    expect(existsSync(file)).toBe(true);
    expect(store.all("a2a").map((r) => r.name)).toEqual(["roxy"]);
    store.close();
  });

  test("redeploy: a wiped agents.d/ is re-materialized from the store on boot", () => {
    const { workspace, dbPath, agentsd } = scratch();
    const store = new RegistrationStore(dbPath);

    // First boot — register roxy via the API path.
    const bus1 = new InMemoryEventBus();
    const reg1 = new ControlPlaneRegistrarPlugin(workspace, store);
    reg1.install(bus1);
    const file = join(agentsd, "roxy.yaml");
    upsert(bus1, "roxy", file, "name: roxy\nurl: http://roxy:7870\n");
    expect(existsSync(file)).toBe(true);

    // Redeploy from a fresh clone — the ephemeral agents.d/ is wiped.
    rmSync(agentsd, { recursive: true, force: true });
    expect(existsSync(file)).toBe(false);

    // Second boot with the SAME durable store — install() re-materializes.
    const reg2 = new ControlPlaneRegistrarPlugin(workspace, store);
    reg2.install(new InMemoryEventBus());

    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("roxy:7870");
    store.close();
  });

  test("remove deletes the file AND forgets it in the store (no zombie re-materialize)", () => {
    const { workspace, dbPath, agentsd } = scratch();
    const store = new RegistrationStore(dbPath);
    const bus = new InMemoryEventBus();
    const reg = new ControlPlaneRegistrarPlugin(workspace, store);
    reg.install(bus);
    const file = join(agentsd, "roxy.yaml");

    upsert(bus, "roxy", file, "name: roxy\n");
    expect(store.all("a2a")).toHaveLength(1);

    bus.publish("command.a2a.remove", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "command.a2a.remove",
      timestamp: 0,
      payload: { name: "roxy", file },
    });
    expect(existsSync(file)).toBe(false);
    expect(store.all("a2a")).toEqual([]);

    // A subsequent boot must NOT resurrect the removed registration.
    rmSync(agentsd, { recursive: true, force: true });
    new ControlPlaneRegistrarPlugin(workspace, store).install(new InMemoryEventBus());
    expect(existsSync(file)).toBe(false);
    store.close();
  });

  test("no store → behaves exactly as before (ephemeral only, no throw)", () => {
    const { workspace, agentsd } = scratch();
    const bus = new InMemoryEventBus();
    const reg = new ControlPlaneRegistrarPlugin(workspace); // no store
    reg.install(bus);
    const file = join(agentsd, "roxy.yaml");
    upsert(bus, "roxy", file, "name: roxy\n");
    expect(existsSync(file)).toBe(true); // still writes the cache
  });
});
