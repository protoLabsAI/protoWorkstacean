import { describe, test, expect } from "bun:test";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { ClawpatchCacheCleanupSkillExecutorPlugin } from "../clawpatch-cache-cleanup-skill-executor-plugin.ts";
import { CheckoutCache } from "../../../lib/checkout-cache.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";

class FakeCache extends CheckoutCache {
  constructor(private readonly result: { evicted: number; bytesFreed: number } | Error) {
    super({
      root: "/tmp/fake-not-used",
      getToken: async () => "x",
      cloneRepo: async () => {},
    });
  }
  override async prune(): Promise<{ evicted: number; bytesFreed: number }> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

describe("ClawpatchCacheCleanupSkillExecutorPlugin", () => {
  test("registers ceremony.clawpatch_cache_cleanup and runs prune on dispatch", async () => {
    const registry = new ExecutorRegistry();
    const fake = new FakeCache({ evicted: 7, bytesFreed: 12345 });
    const plugin = new ClawpatchCacheCleanupSkillExecutorPlugin(registry, fake);
    plugin.install(new InMemoryEventBus());

    const executor = registry.resolve("ceremony.clawpatch_cache_cleanup", []);
    expect(executor).not.toBeNull();
    const result = await executor!.execute({
      skill: "ceremony.clawpatch_cache_cleanup",
      content: "",
      correlationId: "test-corr",
      replyTopic: "test.reply",
      payload: { skill: "ceremony.clawpatch_cache_cleanup", content: "" } as never,
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("evicted=7");
    expect(result.text).toContain("bytesFreed=12345");
    expect(result.correlationId).toBe("test-corr");

    plugin.uninstall();
  });

  test("returns isError=true when prune throws", async () => {
    const registry = new ExecutorRegistry();
    const fake = new FakeCache(new Error("disk full"));
    const plugin = new ClawpatchCacheCleanupSkillExecutorPlugin(registry, fake);
    plugin.install(new InMemoryEventBus());

    const executor = registry.resolve("ceremony.clawpatch_cache_cleanup", []);
    const result = await executor!.execute({
      skill: "ceremony.clawpatch_cache_cleanup",
      content: "",
      correlationId: "test-err",
      replyTopic: "test.reply",
      payload: { skill: "ceremony.clawpatch_cache_cleanup", content: "" } as never,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("disk full");

    plugin.uninstall();
  });
});
