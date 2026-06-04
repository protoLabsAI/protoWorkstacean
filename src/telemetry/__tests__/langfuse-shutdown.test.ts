import { describe, expect, test } from "bun:test";
import { shutdownLangfuseTracer } from "../langfuse-tracer.ts";

describe("shutdownLangfuseTracer", () => {
  test("resolves and is idempotent when no provider was registered (no-creds path)", async () => {
    // In the test env LANGFUSE_* keys are unset, so initLangfuseTracer never
    // installed a provider. Shutdown must be a safe no-op, callable repeatedly
    // (e.g. SIGTERM then SIGINT) without throwing.
    await expect(shutdownLangfuseTracer()).resolves.toBeUndefined();
    await expect(shutdownLangfuseTracer()).resolves.toBeUndefined();
  });
});
