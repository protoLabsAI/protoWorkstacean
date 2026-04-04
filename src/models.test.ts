import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

describe("models.json", () => {
  const modelsPath = resolve(process.cwd(), "models.json");
  let config: Record<string, unknown>;

  test("file exists", () => {
    expect(existsSync(modelsPath)).toBe(true);
  });

  test("valid JSON structure", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    config = JSON.parse(raw);
    expect(config).toHaveProperty("providers");
  });

  test("local-llm provider configured", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers).toHaveProperty("local-llm");
  });

  test("local-llm has correct base_url", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers["local-llm"].baseUrl).toBe("https://bios-pc.cloud.bios.dev:8443/v1");
  });

  test("local-llm uses openai-completions api", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers["local-llm"].api).toBe("openai-completions");
  });

  test("local-llm model configured", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const models = parsed.providers["local-llm"].models;
    expect(models).toBeArray();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe("default");
  });

  test("model has required fields", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const model = parsed.providers["local-llm"].models[0];
    expect(model).toHaveProperty("name");
    expect(model).toHaveProperty("reasoning");
    expect(model).toHaveProperty("input");
    expect(model).toHaveProperty("contextWindow");
    expect(model).toHaveProperty("maxTokens");
    expect(model).toHaveProperty("cost");
  });

  test("compat settings present", () => {
    const raw = readFileSync(modelsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const compat = parsed.providers["local-llm"].compat;
    expect(compat).toHaveProperty("supportsUsageInStreaming");
    expect(compat).toHaveProperty("maxTokensField");
    expect(compat.maxTokensField).toBe("max_tokens");
  });
});
