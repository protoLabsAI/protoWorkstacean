/**
 * User identity type definitions — workspace/users.yaml schema.
 *
 * A user entry maps a canonical identity to all their platform-specific IDs.
 * This allows agents to recognise that the same human is behind a Discord
 * message, a GitHub comment, a Signal DM, etc. — and share memory across them.
 */

import type { ChannelPlatform } from "./channels.ts";

/**
 * Per-platform identity mapping.
 * Keys are platform names; values are the platform-native user ID.
 */
export type PlatformIdentities = Partial<Record<ChannelPlatform, string>>;

export interface UserIdentity {
  /**
   * Canonical user ID — used as the Graphiti group_id key.
   * Short, stable, human-readable (e.g. "josh", "alice").
   * Must be unique across all users.
   */
  id: string;

  /** Human-readable display name. */
  displayName?: string;

  /**
   * When true, this user gets memory enrichment on inbound messages.
   * Default: true if the entry exists.
   */
  memoryEnabled?: boolean;

  /**
   * Whether this user is an admin (mirrors the discord admins list).
   * If true, their platform IDs also count as admin IDs.
   */
  admin?: boolean;

  /**
   * Platform-specific IDs for this user.
   * discord: snowflake ID
   * github:  username
   * signal:  E.164 phone number
   * slack:   member ID (Uxxxxxxxx)
   * plane:   user email or UUID
   */
  identities: PlatformIdentities;
}

export interface UsersYaml {
  users?: UserIdentity[];
}
