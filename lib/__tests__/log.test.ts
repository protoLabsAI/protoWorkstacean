import { describe, expect, test, afterEach } from "bun:test";
import { logger } from "../log.ts";

// Capture console output for assertions.
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.warn = console.log;
  console.error = console.log;
  try { fn(); } finally { Object.assign(console, orig); }
  return lines;
}
const env = (o: Record<string, string>) => { Object.assign(process.env, o); };
let prevNodeEnv: string | undefined;
afterEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_FORMAT;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  prevNodeEnv = undefined;
});

describe("logger", () => {
  test("JSON format emits one structured object per line with component + fields", () => {
    env({ LOG_FORMAT: "json" });
    const lines = capture(() => logger("a2a").info("dispatched", { correlationId: "c1", skill: "chat" }));
    const obj = JSON.parse(lines[0]);
    expect(obj).toMatchObject({ level: "info", component: "a2a", msg: "dispatched", correlationId: "c1", skill: "chat" });
    expect(obj.ts).toBeDefined();
  });

  test("LOG_LEVEL gates lower-severity lines", () => {
    env({ LOG_LEVEL: "warn", LOG_FORMAT: "json" });
    const lines = capture(() => {
      const l = logger("x");
      l.debug("d"); l.info("i"); l.warn("w"); l.error("e");
    });
    expect(lines).toHaveLength(2); // warn + error only
    expect(lines.map((l) => JSON.parse(l).level)).toEqual(["warn", "error"]);
  });

  test("child() binds fields onto every line", () => {
    env({ LOG_FORMAT: "json" });
    const lines = capture(() => logger("svc").child({ correlationId: "c9" }).info("hi", { extra: 1 }));
    expect(JSON.parse(lines[0])).toMatchObject({ correlationId: "c9", extra: 1 });
  });

  test("Error fields are serialized to {message, stack}", () => {
    env({ LOG_FORMAT: "json" });
    const lines = capture(() => logger("x").error("boom", { err: new Error("kaboom") }));
    expect(JSON.parse(lines[0]).err.message).toBe("kaboom");
  });

  test("dev format is a readable single line", () => {
    // Dev format requires non-JSON output: useJson() is true when
    // NODE_ENV==="production" (the Docker build gate runs the suite that way)
    // OR LOG_FORMAT==="json". Force dev format by clearing NODE_ENV; afterEach
    // restores it. LOG_FORMAT is already unset here.
    prevNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    const lines = capture(() => logger("x").info("hello", { a: 1 }));
    expect(lines[0]).toContain("INFO [x] hello");
    expect(lines[0]).toContain('{"a":1}');
  });
});
