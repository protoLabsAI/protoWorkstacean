/**
 * QuinnVerdictCounters — top-right floating panel on /system showing
 * Quinn's review verdict counts per repo, since this dashboard tab opened.
 *
 * Subscribes to `quinn.review.submitted` over the same WS endpoint
 * SystemGraph uses (`/api/bus/subscribe?topic=…`). Pure browser-side
 * accumulation — no /api/bus/history backfill on v1, so a fresh tab
 * starts at 0 across the board. (Future: seed from history once the
 * /api/bus/history endpoint supports topic-filter queries.)
 *
 * Auto-reconnects with a 2s backoff on close, same shape as
 * SystemGraph's WS handler — keeps the panel populated through workstacean
 * restarts.
 */

import { useEffect, useState } from "preact/hooks";

interface Counts {
  approved: number;
  requestedChanges: number;
  commented: number;
}

interface ReviewSubmittedPayload {
  owner?: string;
  repo?: string;
  prNumber?: number;
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
}

const EMPTY: Counts = { approved: 0, requestedChanges: 0, commented: 0 };

export default function QuinnVerdictCounters() {
  // Per-repo counts; key is `${owner}/${repo}`.
  const [counts, setCounts] = useState<Map<string, Counts>>(new Map());
  const [openedAt] = useState<number>(() => Date.now());
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/bus/subscribe?topic=quinn.review.submitted`;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => setWsStatus("connected");
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { payload?: ReviewSubmittedPayload };
          const p = msg.payload;
          if (!p?.owner || !p?.repo || !p?.event) return;
          const key = `${p.owner}/${p.repo}`;
          setCounts((cur) => {
            const next = new Map(cur);
            const existing = { ...(next.get(key) ?? EMPTY) };
            if (p.event === "APPROVE") existing.approved++;
            else if (p.event === "REQUEST_CHANGES") existing.requestedChanges++;
            else if (p.event === "COMMENT") existing.commented++;
            next.set(key, existing);
            return next;
          });
        } catch {
          // Ignore malformed frames — WS may emit framing data.
        }
      };
      ws.onclose = () => {
        setWsStatus("disconnected");
        if (stopped) return;
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  // Sort repos by total volume desc; row with the most signal first.
  const rows = [...counts.entries()]
    .map(([repo, c]) => ({ repo, ...c, total: c.approved + c.requestedChanges + c.commented }))
    .sort((a, b) => b.total - a.total);

  const totals = rows.reduce(
    (acc, r) => ({
      approved: acc.approved + r.approved,
      requestedChanges: acc.requestedChanges + r.requestedChanges,
      commented: acc.commented + r.commented,
    }),
    { approved: 0, requestedChanges: 0, commented: 0 },
  );

  const grandTotal = totals.approved + totals.requestedChanges + totals.commented;
  const sinceMin = Math.floor((Date.now() - openedAt) / 60_000);

  return (
    <aside class="qvc-panel" aria-label="Quinn review verdicts since page load">
      <header class="qvc-head">
        <div>
          <h3>Quinn verdicts</h3>
          <p class="qvc-meta">
            since tab opened {sinceMin}m ago ·{" "}
            <span class={`qvc-status qvc-status--${wsStatus}`}>{wsStatus}</span>
          </p>
        </div>
      </header>

      {rows.length === 0 ? (
        <div class="qvc-empty">No verdicts observed yet.</div>
      ) : (
        <table class="qvc-table">
          <thead>
            <tr>
              <th>repo</th>
              <th class="qvc-num qvc-approve" title="APPROVE">✓</th>
              <th class="qvc-num qvc-block"   title="REQUEST_CHANGES">✗</th>
              <th class="qvc-num qvc-comment" title="COMMENT">💬</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.repo}>
                <td class="qvc-repo" title={r.repo}>{r.repo}</td>
                <td class="qvc-num qvc-approve">{r.approved || ""}</td>
                <td class="qvc-num qvc-block">{r.requestedChanges || ""}</td>
                <td class="qvc-num qvc-comment">{r.commented || ""}</td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr class="qvc-total-row">
                <td class="qvc-repo">total ({grandTotal})</td>
                <td class="qvc-num qvc-approve">{totals.approved || ""}</td>
                <td class="qvc-num qvc-block">{totals.requestedChanges || ""}</td>
                <td class="qvc-num qvc-comment">{totals.commented || ""}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <style>{STYLES}</style>
    </aside>
  );
}

const STYLES = `
  .qvc-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 5;
    min-width: 220px;
    max-width: 320px;
    background: rgba(13, 17, 23, 0.92);
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.8rem;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .qvc-head {
    padding: 0.5rem 0.75rem 0.4rem;
    border-bottom: 1px solid #21262d;
  }
  .qvc-head h3 {
    margin: 0;
    font-size: 0.85rem;
    color: #e6edf3;
  }
  .qvc-meta {
    margin: 0.2rem 0 0;
    color: #8b949e;
    font-size: 0.7rem;
  }
  .qvc-status { font-weight: 500; }
  .qvc-status--connected    { color: #3fb950; }
  .qvc-status--connecting   { color: #d29922; }
  .qvc-status--disconnected { color: #f85149; }
  .qvc-empty {
    padding: 0.75rem;
    color: #8b949e;
    font-size: 0.75rem;
  }
  .qvc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  .qvc-table thead th {
    text-align: left;
    color: #6e7681;
    font-weight: 500;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid #21262d;
  }
  .qvc-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px dashed #21262d;
  }
  .qvc-table tbody tr:last-child td { border-bottom: none; }
  .qvc-num { text-align: right; width: 2.4rem; }
  .qvc-approve { color: #3fb950; }
  .qvc-block   { color: #f85149; }
  .qvc-comment { color: #58a6ff; }
  .qvc-repo {
    color: #c9d1d9;
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .qvc-total-row td {
    border-top: 1px solid #30363d;
    color: #e6edf3;
    font-weight: 500;
  }
`;
