import { Component, type ErrorInfo, type ReactNode } from "react";

// Contains a render-time crash to the routed workspace so a single bad pane
// can't blank the whole app (the rail + chrome stay usable). Also surfaces the
// error message + stack so the failure is diagnosable instead of a blank screen.
// Keyed by route path in Shell so navigating away resets it.

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[dashboard] pane crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, color: "var(--text-primary)", fontFamily: "ui-monospace, monospace", maxWidth: 880 }}>
        <h3 style={{ color: "var(--text-danger)", margin: "0 0 8px" }}>This pane crashed</h3>
        <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "0 0 12px" }}>
          The rest of the dashboard is fine — use the sidebar to switch views, or reload.
        </p>
        <pre style={{
          background: "var(--bg-default)", border: "1px solid var(--border-default)", borderRadius: 6,
          padding: 12, fontSize: 12, color: "var(--text-danger)", whiteSpace: "pre-wrap", overflow: "auto",
        }}>
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ""}
        </pre>
      </div>
    );
  }
}
