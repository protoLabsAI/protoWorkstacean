import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../metrics.ts";

describe("MetricsRegistry", () => {
  test("renders counters with labels in Prometheus format", () => {
    const m = new MetricsRegistry();
    m.inc("workstacean_dispatch_total", { skill: "chat", success: "true" });
    m.inc("workstacean_dispatch_total", { skill: "chat", success: "true" });
    m.inc("workstacean_dispatch_total", { skill: "chat", success: "false" });
    const out = m.render();
    expect(out).toContain("# TYPE workstacean_dispatch_total counter");
    expect(out).toContain('workstacean_dispatch_total{skill="chat",success="true"} 2');
    expect(out).toContain('workstacean_dispatch_total{skill="chat",success="false"} 1');
  });

  test("renders a histogram with cumulative buckets, sum, and count", () => {
    const m = new MetricsRegistry();
    m.observe("workstacean_dispatch_duration_ms", 80, { skill: "chat" });   // bucket le=100
    m.observe("workstacean_dispatch_duration_ms", 3000, { skill: "chat" }); // bucket le=5000
    const out = m.render();
    expect(out).toContain("# TYPE workstacean_dispatch_duration_ms histogram");
    // cumulative: le=100 has 1, le=5000 has 2, +Inf has 2
    expect(out).toContain('workstacean_dispatch_duration_ms_bucket{le="100",skill="chat"} 1');
    expect(out).toContain('workstacean_dispatch_duration_ms_bucket{le="5000",skill="chat"} 2');
    expect(out).toContain('workstacean_dispatch_duration_ms_bucket{le="+Inf",skill="chat"} 2');
    expect(out).toContain('workstacean_dispatch_duration_ms_sum{skill="chat"} 3080');
    expect(out).toContain('workstacean_dispatch_duration_ms_count{skill="chat"} 2');
  });
});
