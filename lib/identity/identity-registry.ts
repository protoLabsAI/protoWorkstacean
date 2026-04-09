/**
 * IdentityRegistry — resolves platform-specific user IDs to canonical identities.
 *
 * Loads workspace/users.yaml and watches it for live changes (same pattern as
 * ChannelRegistry). Provides a single lookup point so any plugin can resolve
 * "discord user 123456789" → canonical UserIdentity with group_id "josh".
 *
 * Usage:
 *   const registry = new IdentityRegistry("/workspace");
 *   const identity = registry.resolve("discord", "123456789");
 *   // → { id: "josh", displayName: "Josh", ... }
 *
 *   const groupId = registry.groupId("discord", "123456789");
 *   // → "user:josh"   (or "user:discord_123456789" if not mapped)
 */

import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { UserIdentity, UsersYaml } from "../types/users.ts";

export class IdentityRegistry {
  private users: UserIdentity[] = [];
  /** platform → platformId → UserIdentity */
  private index = new Map<string, Map<string, UserIdentity>>();
  private readonly filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, "users.yaml");
    this._load();
    this._watch();
  }

  /**
   * Resolve a platform-specific ID to a canonical UserIdentity.
   * Returns null if no mapping exists for this user.
   */
  resolve(platform: string, platformId: string): UserIdentity | null {
    return this.index.get(platform)?.get(platformId) ?? null;
  }

  /**
   * Return the Graphiti group_id for a user.
   * If the user is known: "user:{canonicalId}"   e.g. "user:josh"
   * If unknown:           "user:{platform}_{platformId}"  e.g. "user:discord_123456"
   */
  groupId(platform: string, platformId: string): string {
    const user = this.resolve(platform, platformId);
    return user ? `user:${user.id}` : `user:${platform}_${platformId}`;
  }

  /**
   * Return all known platform IDs for a given canonical user ID across all platforms.
   * Useful for cross-platform lookups.
   */
  platformIds(canonicalId: string): PlatformIdentities {
    const user = this.users.find(u => u.id === canonicalId);
    return user?.identities ?? {};
  }

  /**
   * Return all users with memoryEnabled (default true if omitted).
   */
  memoryEnabledUsers(): UserIdentity[] {
    return this.users.filter(u => u.memoryEnabled !== false);
  }

  /**
   * Return all admin user platform IDs for a given platform.
   * Supplements the discord.yaml admins list.
   */
  adminIds(platform: string): string[] {
    return this.users
      .filter(u => u.admin === true)
      .map(u => u.identities[platform as keyof typeof u.identities])
      .filter((id): id is string => !!id);
  }

  unwatch(): void {
    unwatchFile(this.filePath);
  }

  private _load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = parseYaml(raw) as UsersYaml;
      this.users = parsed?.users ?? [];
      this._buildIndex();
      console.log(`[identity] Loaded ${this.users.length} user identity(ies) from users.yaml`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.info("[identity] No users.yaml found — identity resolution disabled");
      } else {
        console.error("[identity] Error loading users.yaml:", err);
      }
      this.users = [];
      this.index.clear();
    }
  }

  private _buildIndex(): void {
    this.index.clear();
    for (const user of this.users) {
      for (const [platform, platformId] of Object.entries(user.identities)) {
        if (!platformId) continue;
        if (!this.index.has(platform)) this.index.set(platform, new Map());
        this.index.get(platform)!.set(platformId, user);
      }
    }
  }

  private _watch(): void {
    watchFile(this.filePath, { interval: 2000 }, () => {
      console.log("[identity] users.yaml changed — reloading");
      this._load();
    });
  }
}

// Re-export for convenience
type PlatformIdentities = UserIdentity["identities"];
