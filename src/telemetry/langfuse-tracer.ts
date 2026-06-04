/**
 * Langfuse OTEL tracer bootstrap.
 *
 * Creates and registers a NodeTracerProvider with a LangfuseSpanProcessor
 * so that any call to `startObservation` / `startActiveObservation` from
 * `@langfuse/tracing` — or to `@langfuse/langchain`'s CallbackHandler — is
 * actually captured and shipped to Langfuse.
 *
 * Gated on both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY being present.
 * Unset → function returns false, no provider is registered, all subsequent
 * `startObservation` calls fall through to the no-op default tracer (which
 * is the correct behaviour for a dev / CI environment without Langfuse
 * credentials).
 *
 * Must be called exactly once during startup, before any plugin that emits
 * spans is installed.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";
import { logger } from "../../lib/log.ts";

const log = logger("langfuse");

let initialized = false;
let activeProvider: NodeTracerProvider | null = null;

/**
 * Register the Langfuse OTEL tracer provider. Returns true when a live
 * provider was installed, false when credentials were missing.
 *
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function initLangfuseTracer(): boolean {
  if (initialized) return true;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return false;

  // LangfuseSpanProcessor reads LANGFUSE_* env vars itself — we don't need
  // to pass config here. It batches and flushes on a timer + on shutdown.
  const provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  setLangfuseTracerProvider(provider);
  activeProvider = provider;
  initialized = true;
  return true;
}

/**
 * Flush + shut down the tracer provider so batched spans aren't lost on a
 * graceful redeploy. No-op when no provider was registered. (#792)
 */
export async function shutdownLangfuseTracer(): Promise<void> {
  if (!activeProvider) return;
  try {
    await activeProvider.shutdown();
  } catch (err) {
    log.warn("tracer shutdown/flush failed", { err });
  } finally {
    activeProvider = null;
    initialized = false;
  }
}
