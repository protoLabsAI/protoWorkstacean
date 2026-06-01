import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { WebSocketManager } from "./lib/websocket";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./Layout.css";

const NAV_ITEMS = [
  { to: "/", label: "Overview", title: "Overview" },
  { to: "/system", label: "System", title: "System" },
  { to: "/trace", label: "Trace", title: "Skill Trace" },
  { to: "/events", label: "Events", title: "Events" },
  { to: "/agents", label: "Agents", title: "Agents" },
  { to: "/console", label: "Console", title: "Console" },
] as const;

// Routes whose component manages its own scroll/height (graph, live feeds) —
// the content area drops its padding and overflow so they can fill it.
const FULL_BLEED = new Set<string>(["/system", "/trace", "/events"]);

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

export default function Layout() {
  const { pathname } = useLocation();
  const status = useWsStatus();
  const active = NAV_ITEMS.find((i) => i.to === pathname);
  const title = active?.title ?? "Workstacean";
  const fullBleed = FULL_BLEED.has(pathname);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-icon">⬡</span>
          <span className="logo-text">Workstacean</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `nav-item${isActive ? " nav-item--active" : ""}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="main-wrapper">
        <header className="header">
          <h1 className="header-title">{title}</h1>
          <div className="header-status">
            <span className={`status-dot status-dot--${status}`} />
            <span className="status-label">{STATUS_LABEL[status]}</span>
          </div>
        </header>

        <main className={`main-content${fullBleed ? " main-content--full" : ""}`}>
          {/* Keyed by path so a crash in one pane resets when you navigate away,
              and never takes down the sidebar/nav with it. */}
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
