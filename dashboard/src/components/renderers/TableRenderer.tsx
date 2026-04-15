// TableRenderer — renders a dynamic columnar table from a TableWidgetDescriptor.
//
// Column definitions come from the descriptor config. Data is fetched via
// widget.query and must be an array of objects. Missing or invalid data is
// handled gracefully with empty-state and error views.

import { useState, useEffect } from "preact/hooks";
import type { TableWidgetDescriptor } from "../../lib/widget-renderer";
import { fetchWidgetData } from "../../lib/widget-renderer";

type DataRow = Record<string, unknown>;

function cellValue(row: DataRow, key: string): string {
  const v = row[key];
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

interface TableRendererProps {
  descriptor: TableWidgetDescriptor;
}

export default function TableRenderer({ descriptor }: TableRendererProps) {
  const [rows, setRows] = useState<DataRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { config } = descriptor;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchWidgetData<unknown>(descriptor);
        if (cancelled) return;
        if (!Array.isArray(result)) {
          setError("Expected array data for table");
          return;
        }
        setRows(result as DataRow[]);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }

    load();
    const ttl = descriptor.query.ttl ?? 30_000;
    const id = setInterval(load, ttl);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [descriptor.id, descriptor.query.url]);

  return (
    <>
      <style>{`
        .table-renderer {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
        }
        .table-renderer__title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #e6edf3);
          letter-spacing: 0.02em;
        }
        .table-renderer__scroll {
          overflow-x: auto;
          border-radius: 6px;
          border: 1px solid var(--border-default, #30363d);
        }
        .table-renderer__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .table-renderer__table thead tr {
          background: var(--bg-subtle, #161b22);
        }
        .table-renderer__table th {
          padding: 8px 12px;
          color: var(--text-muted, #8b949e);
          font-weight: 500;
          white-space: nowrap;
          border-bottom: 1px solid var(--border-default, #30363d);
        }
        .table-renderer__table td {
          padding: 7px 12px;
          color: var(--text-primary, #e6edf3);
          border-bottom: 1px solid var(--border-subtle, #21262d);
          vertical-align: middle;
          max-width: 240px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .table-renderer__table tbody tr:last-child td {
          border-bottom: none;
        }
        .table-renderer__table tbody tr:hover td {
          background: var(--bg-subtle, #161b22);
        }
        .table-renderer__empty,
        .table-renderer__error {
          font-size: 12px;
          color: var(--text-muted, #8b949e);
          padding: 24px;
          text-align: center;
        }
        .table-renderer__error {
          color: var(--color-danger, #f85149);
        }
      `}</style>
      <div class="table-renderer">
        <div class="table-renderer__title">{descriptor.title}</div>

        {error ? (
          <div class="table-renderer__error">{error}</div>
        ) : rows === null ? (
          <div class="table-renderer__empty">Loading…</div>
        ) : rows.length === 0 ? (
          <div class="table-renderer__empty">No data</div>
        ) : (
          <div class="table-renderer__scroll">
            <table class="table-renderer__table">
              <thead>
                <tr>
                  {config.columns.map((col) => (
                    <th
                      key={col.key}
                      style={{ textAlign: col.align ?? "left" }}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {config.columns.map((col) => (
                      <td
                        key={col.key}
                        style={{ textAlign: col.align ?? "left" }}
                        title={cellValue(row, col.key)}
                      >
                        {cellValue(row, col.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
