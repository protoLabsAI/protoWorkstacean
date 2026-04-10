import { useState } from "preact/hooks";

interface JsonTreeProps {
  value: unknown;
  depth?: number;
}

const MAX_AUTO_EXPAND_DEPTH = 2;

function JsonNode({ value, depth = 0 }: JsonTreeProps) {
  const [expanded, setExpanded] = useState(depth < MAX_AUTO_EXPAND_DEPTH);

  if (value === null) {
    return <span class="json-null">null</span>;
  }

  if (typeof value === "boolean") {
    return <span class="json-bool">{String(value)}</span>;
  }

  if (typeof value === "number") {
    return <span class="json-number">{String(value)}</span>;
  }

  if (typeof value === "string") {
    return <span class="json-string">"{value}"</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span class="json-bracket">[]</span>;
    }

    return (
      <span>
        <button class="json-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▼" : "▶"}
        </button>
        <span class="json-bracket">[</span>
        {expanded ? (
          <div class="json-children">
            {value.map((item, i) => (
              <div key={i} class="json-row">
                <span class="json-index">{i}: </span>
                <JsonNode value={item} depth={depth + 1} />
                {i < value.length - 1 && <span class="json-comma">,</span>}
              </div>
            ))}
          </div>
        ) : (
          <span class="json-collapsed"> {value.length} items </span>
        )}
        <span class="json-bracket">]</span>
      </span>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return <span class="json-bracket">{"{}"}</span>;
    }

    return (
      <span>
        <button class="json-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▼" : "▶"}
        </button>
        <span class="json-bracket">{"{"}</span>
        {expanded ? (
          <div class="json-children">
            {keys.map((key, i) => (
              <div key={key} class="json-row">
                <span class="json-key">"{key}"</span>
                <span class="json-colon">: </span>
                <JsonNode value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
                {i < keys.length - 1 && <span class="json-comma">,</span>}
              </div>
            ))}
          </div>
        ) : (
          <span class="json-collapsed"> {keys.length} keys </span>
        )}
        <span class="json-bracket">{"}"}</span>
      </span>
    );
  }

  return <span class="json-unknown">{String(value)}</span>;
}

export default function JsonTree({ value }: JsonTreeProps) {
  return (
    <>
      <style>{`
        .json-tree {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          font-size: 12px;
          line-height: 1.6;
          color: #c9d1d9;
        }
        .json-children {
          padding-left: 20px;
          border-left: 1px solid #30363d;
          margin-left: 4px;
        }
        .json-row {
          display: block;
        }
        .json-toggle {
          background: none;
          border: none;
          color: #8b949e;
          cursor: pointer;
          font-size: 10px;
          padding: 0 4px 0 0;
          vertical-align: middle;
          line-height: 1;
        }
        .json-toggle:hover {
          color: #c9d1d9;
        }
        .json-key { color: #79c0ff; }
        .json-string { color: #a5d6ff; }
        .json-number { color: #79c0ff; }
        .json-bool { color: #ff7b72; }
        .json-null { color: #8b949e; font-style: italic; }
        .json-bracket { color: #c9d1d9; }
        .json-colon { color: #8b949e; }
        .json-comma { color: #8b949e; }
        .json-index { color: #8b949e; }
        .json-collapsed { color: #8b949e; font-style: italic; }
        .json-unknown { color: #c9d1d9; }
      `}</style>
      <div class="json-tree">
        <JsonNode value={value} depth={0} />
      </div>
    </>
  );
}
