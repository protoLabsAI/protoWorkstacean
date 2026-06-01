import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";

// Custom confirmation modal for destructive actions — used instead of the
// browser's window.confirm so an accidental click can't silently drop a live
// agent. Click-outside or Escape cancels. Mirrors the protoAgent operator
// console's ConfirmDialog (the house pattern), built on the --pl-* tokens; a
// candidate to contribute upstream into @protolabsai/ui (which lacks a dialog).

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Remove",
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0, 0, 0, 0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-default)",
          border: "1px solid var(--border-default)",
          borderRadius: "8px",
          padding: "20px",
          width: "min(420px, 90vw)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px", color: danger ? "var(--text-danger)" : "var(--text-primary)" }}>
          {danger && <AlertTriangle size={16} />}
          <h2 style={{ fontSize: "15px", margin: 0, color: "var(--text-primary)" }}>{title}</h2>
        </div>
        {message && <p style={{ color: "var(--text-secondary)", fontSize: "13px", marginBottom: "16px" }}>{message}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "6px 14px", borderRadius: "6px", fontSize: "13px", cursor: "pointer",
              background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-default)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            style={{
              padding: "6px 14px", borderRadius: "6px", fontSize: "13px", cursor: "pointer", fontWeight: 500,
              background: "transparent",
              color: danger ? "var(--text-danger)" : "var(--accent-fg)",
              border: `1px solid ${danger ? "var(--text-danger)" : "var(--accent-emphasis)"}`,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
