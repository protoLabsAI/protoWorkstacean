import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  Bot,
  GitBranch,
  Hexagon,
  LayoutDashboard,
  ListTree,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { WebSocketManager } from "./lib/websocket";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./Shell.css";

/**
 * Shell — the protoAgent-style app frame (ADR-0008 P1, WS-2).
 *
 * Three-row grid: topbar (48px) / workspace / utility-bar (28px). The
 * workspace row is a 72px lucide icon rail | the routed surface | a
 * resizable+collapsible right dock. React-router stays the source of truth
 * (deep-links like /executions?target=… keep working); the rail is just a
 * NavLink set and the Outlet renders the active surface.
 */

interface NavItem {
  to: string;
  label: string;
  /** One-liner shown in the right dock for context. */
  desc: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Overview", desc: "Fleet at a glance — health, counts, recent activity.", icon: LayoutDashboard },
  { to: "/system", label: "System", desc: "Live plugin↔topic↔agent graph. Click an agent to see its executions.", icon: Network },
  { to: "/trace", label: "Trace", desc: "Per-correlation skill trace — the spine of one dispatch.", icon: GitBranch },
  { to: "/events", label: "Events", desc: "Raw bus event stream, live over the WebSocket.", icon: Radio },
  { to: "/executions", label: "Executions", desc: "Durable dispatch log over the flow store. Drill into any trace.", icon: ListTree },
  { to: "/agents", label: "Agents", desc: "Registered agents — in-process builtin and remote A2A.", icon: Bot },
  { to: "/console", label: "Console", desc: "Direct skill console — fire a dispatch by hand.", icon: Terminal },
];

// Routes whose component manages its own scroll/height (graph, live feeds) —
// the workspace drops its padding and overflow so they can fill it.
const FULL_BLEED = new Set<string>(["/system", "/trace", "/events"]);

// Right-dock geometry. Width is drag-resizable within these bounds and
// persisted, along with the collapsed flag, across reloads.
const PANEL_MIN = 240;
const PANEL_MAX = 560;
const PANEL_DEFAULT = 320;
const LS_WIDTH = "ws.shell.panelWidth";
const LS_COLLAPSED = "ws.shell.panelCollapsed";

type WsStatus = "connecting" | "connected" | "disconnected";

const STATUS_LABEL: Record<WsStatus, string> = {
  connected: "Live",
  connecting: "Connecting…",
  disconnected: "Disconnected",
};

/** Header live/disconnected indicator — its own /ws connection, independent of any page. */
function useWsStatus(): WsStatus {
  const [status, setStatus] = useState<WsStatus>("connecting");
  useEffect(() => {
    const manager = new WebSocketManager("/ws");
    const off = manager.onStatus(setStatus);
    manager.connect();
    return () => {
      off();
      manager.destroy();
    };
  }, []);
  return status;
}

function clampWidth(w: number): number {
  return Math.min(PANEL_MAX, Math.max(PANEL_MIN, w));
}

export default function Shell() {
  const { pathname } = useLocation();
  const status = useWsStatus();
  const active = NAV_ITEMS.find((i) => i.to === pathname);
  const title = active?.label ?? "Workstacean";
  const fullBleed = FULL_BLEED.has(pathname);

  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const raw = Number(localStorage.getItem(LS_WIDTH));
    return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : PANEL_DEFAULT;
  });
  const [collapsed, setCollapsed] = useState<boolean>(() => localStorage.getItem(LS_COLLAPSED) !== "false");

  useEffect(() => { localStorage.setItem(LS_WIDTH, String(panelWidth)); }, [panelWidth]);
  useEffect(() => { localStorage.setItem(LS_COLLAPSED, String(collapsed)); }, [collapsed]);

  // Drag-to-resize the dock. Pointer events on the resizer; width grows as the
  // pointer moves left (the dock is right-anchored). Listeners live for the
  // duration of one drag and clean themselves up on pointerup.
  const draggingRef = useRef(false);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return;
      setPanelWidth(clampWidth(window.innerWidth - ev.clientX));
    };
    const onUp = () => {
      draggingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  return (
    <div className="shell">
      <header className="shell__topbar">
        <div className="shell__brand">
          <Hexagon className="shell__brand-mark" size={18} strokeWidth={2.25} />
          <span className="shell__brand-text">Workstacean</span>
        </div>
        <h1 className="shell__title">{title}</h1>
        <div className="shell__topbar-right">
          <button
            className="shell__panel-toggle"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Open context panel" : "Close context panel"}
            aria-label={collapsed ? "Open context panel" : "Close context panel"}
            aria-pressed={!collapsed}
          >
            {collapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          </button>
        </div>
      </header>

      <div className="shell__body">
        <nav className="shell__rail" aria-label="Surfaces">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `shell__rail-item${isActive ? " shell__rail-item--active" : ""}`}
                title={item.label}
                aria-label={item.label}
              >
                <Icon size={20} strokeWidth={1.75} />
                <span className="shell__rail-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <main className={`shell__workspace${fullBleed ? " shell__workspace--full" : ""}`}>
          {/* Keyed by path so a crash in one surface resets on navigation and
              never takes the shell chrome down with it. */}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>

        {!collapsed && (
          <>
            <div
              className="shell__resizer"
              onPointerDown={onResizeStart}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize context panel"
            />
            <aside className="shell__panel" style={{ width: panelWidth }}>
              <div className="shell__panel-head">{title}</div>
              <p className="shell__panel-desc">{active?.desc ?? "Select a surface from the rail."}</p>
            </aside>
          </>
        )}
      </div>

      <footer className="shell__utility">
        <span className="shell__util-status">
          <span className={`shell__dot shell__dot--${status}`} />
          {STATUS_LABEL[status]}
        </span>
        <span className="shell__util-surface">{pathname}</span>
      </footer>
    </div>
  );
}
