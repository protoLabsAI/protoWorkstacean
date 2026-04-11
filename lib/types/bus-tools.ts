/**
 * Shared types for bus tool error handling.
 */

export interface BusToolError {
  code: string;
  message: string;
  details?: unknown;
}
