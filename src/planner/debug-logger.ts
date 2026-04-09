/**
 * DebugLogger — structured logger for the planner subsystem.
 *
 * Prefixes all messages with [planner] and includes correlation IDs.
 * Respects the DEBUG environment variable for verbose output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  component: string;
  message: string;
  correlationId?: string;
  data?: unknown;
  timestamp: number;
}

const DEBUG = typeof process !== "undefined" && process.env["DEBUG"]?.includes("planner");

export class DebugLogger {
  private readonly entries: LogEntry[] = [];

  constructor(
    private readonly component: string,
    private readonly maxHistory = 200
  ) {}

  debug(message: string, correlationId?: string, data?: unknown): void {
    this.log("debug", message, correlationId, data);
    if (DEBUG) {
      console.debug(`[planner:${this.component}] ${message}`, data ?? "");
    }
  }

  info(message: string, correlationId?: string, data?: unknown): void {
    this.log("info", message, correlationId, data);
    if (DEBUG) {
      console.info(`[planner:${this.component}] ${message}`, data ?? "");
    }
  }

  warn(message: string, correlationId?: string, data?: unknown): void {
    this.log("warn", message, correlationId, data);
    console.warn(`[planner:${this.component}] ${message}`, data ?? "");
  }

  error(message: string, correlationId?: string, data?: unknown): void {
    this.log("error", message, correlationId, data);
    console.error(`[planner:${this.component}] ${message}`, data ?? "");
  }

  /** Return all captured log entries. */
  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  /** Return entries at or above the given level. */
  getEntriesAtLevel(level: LogLevel): readonly LogEntry[] {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    const minIdx = levels.indexOf(level);
    return this.entries.filter((e) => levels.indexOf(e.level) >= minIdx);
  }

  /** Clear all captured entries. */
  clear(): void {
    this.entries.length = 0;
  }

  private log(level: LogLevel, message: string, correlationId?: string, data?: unknown): void {
    this.entries.push({
      level,
      component: this.component,
      message,
      correlationId,
      data,
      timestamp: Date.now(),
    });
    if (this.entries.length > this.maxHistory) {
      this.entries.shift();
    }
  }
}
