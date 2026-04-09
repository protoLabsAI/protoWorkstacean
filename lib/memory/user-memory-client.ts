/**
 * UserMemoryClient — reads and writes temporal user facts from the
 * rabbit-hole.io knowledge graph (research-neo4j).
 *
 * Uses Neo4j's HTTP transaction API (no driver required).
 * Schema: Platform_User -[HOLDS_FACT]-> User_Fact
 *
 * Temporal model (Graphiti-inspired):
 *   valid_from / valid_until  — when the fact was true in the world
 *   asserted_at / retracted_at — when we learned/unlearned it
 *   superseded_by              — points to the newer fact that replaced this one
 *
 * Facts with no valid_until are currently active.
 */

export interface UserFact {
  uid: string;
  fact_type: "preference" | "skill" | "interest" | "goal" | "context" | "belief" | "relationship" | "behavior" | "constraint";
  value: string;
  confidence: number;
  valid_from: string;
  valid_until?: string;
  source_channel?: string;
}

export interface StoreFactInput {
  userId: string;
  platform: "discord" | "slack" | "signal" | "github" | "plane";
  displayName?: string;
  fact_type: UserFact["fact_type"];
  value: string;
  confidence: number;
  source_channel?: string;
  source_turn?: string;
  /** UID of an existing fact this supersedes */
  supersedes?: string;
}

interface Neo4jResponse {
  results: Array<{
    columns: string[];
    data: Array<{ row: unknown[] }>;
  }>;
  errors: Array<{ code: string; message: string }>;
}

export class UserMemoryClient {
  private readonly baseUrl: string;
  private readonly auth: string;

  constructor() {
    const host = process.env.NEO4J_USER_MEMORY_HOST ?? "http://research-neo4j:7474";
    const user = process.env.NEO4J_USER_MEMORY_USER ?? "neo4j";
    const pass = process.env.NEO4J_USER_MEMORY_PASS ?? "evidencegraph2024";
    this.baseUrl = `${host}/db/neo4j/tx/commit`;
    this.auth = btoa(`${user}:${pass}`);
  }

  /** Return currently-valid facts for a user, highest-confidence first. */
  async getFacts(userId: string, platform: string, limit = 20): Promise<UserFact[]> {
    const userUid = this._userUid(userId, platform);
    const now = new Date().toISOString();

    const result = await this._query(`
      MATCH (u:Platform_User {uid: $uid})-[r:HOLDS_FACT]->(f:User_Fact)
      WHERE f.valid_from <= $now
        AND (f.valid_until IS NULL OR f.valid_until > $now)
        AND f.retracted_at IS NULL
        AND f.superseded_by IS NULL
      RETURN f.uid, f.fact_type, f.value, f.confidence, f.valid_from, f.valid_until, f.source_channel
      ORDER BY f.confidence DESC
      LIMIT $limit
    `, { uid: userUid, now, limit });

    return (result ?? []).map(row => ({
      uid: row[0] as string,
      fact_type: row[1] as UserFact["fact_type"],
      value: row[2] as string,
      confidence: row[3] as number,
      valid_from: row[4] as string,
      valid_until: row[5] as string | undefined,
      source_channel: row[6] as string | undefined,
    }));
  }

  /**
   * Format facts as a context block to prepend to agent messages.
   * Returns empty string if no facts exist (caller should skip prepend).
   */
  async getContextBlock(userId: string, platform: string): Promise<string> {
    const facts = await this.getFacts(userId, platform);
    if (facts.length === 0) return "";

    const lines = facts.map(f => `- [${f.fact_type}] ${f.value} (confidence: ${Math.round(f.confidence * 100)}%)`);
    return `[User context — ${platform} user ${userId}]\n${lines.join("\n")}\n`;
  }

  /** Upsert a Platform_User node, then create a User_Fact and HOLDS_FACT edge. */
  async storeFact(input: StoreFactInput): Promise<string> {
    const userUid = this._userUid(input.userId, input.platform);
    const factUid = this._factUid(input.userId, input.platform, input.fact_type, input.value);
    const now = new Date().toISOString();

    // 1. Ensure the user node exists
    await this._query(`
      MERGE (u:Platform_User:Entity {uid: $uid})
      ON CREATE SET
        u.platform = $platform,
        u.platform_id = $userId,
        u.display_name = $displayName,
        u.createdAt = datetime(),
        u.updatedAt = datetime(),
        u.clerk_org_id = 'protolabs'
      ON MATCH SET
        u.updatedAt = datetime(),
        u.display_name = COALESCE($displayName, u.display_name)
    `, { uid: userUid, platform: input.platform, userId: input.userId, displayName: input.displayName ?? null });

    // 2. Mark superseded fact as retracted
    if (input.supersedes) {
      await this._query(`
        MATCH (f:User_Fact {uid: $oldUid})
        SET f.retracted_at = $now, f.superseded_by = $newUid
      `, { oldUid: input.supersedes, now, newUid: factUid });
    }

    // 3. Create fact node + relationship
    await this._query(`
      MERGE (f:User_Fact:Entity {uid: $factUid})
      ON CREATE SET
        f.subject_uid = $userUid,
        f.fact_type = $factType,
        f.value = $value,
        f.confidence = $confidence,
        f.valid_from = $now,
        f.asserted_at = $now,
        f.source_channel = $sourceChannel,
        f.source_turn = $sourceTurn,
        f.createdAt = datetime(),
        f.updatedAt = datetime(),
        f.clerk_org_id = 'protolabs'
      ON MATCH SET
        f.confidence = $confidence,
        f.updatedAt = datetime()
      WITH f
      MATCH (u:Platform_User {uid: $userUid})
      MERGE (u)-[r:HOLDS_FACT {uid: $relUid}]->(f)
      ON CREATE SET
        r.valid_from = $now,
        r.confidence = $confidence,
        r.createdAt = datetime()
    `, {
      factUid,
      userUid,
      factType: input.fact_type,
      value: input.value,
      confidence: input.confidence,
      now,
      sourceChannel: input.source_channel ?? null,
      sourceTurn: input.source_turn ?? null,
      relUid: `rel:${userUid}__HOLDS_FACT__${factUid}`,
    });

    return factUid;
  }

  /** Retract a fact (mark valid_until and retracted_at). */
  async retractFact(factUid: string): Promise<void> {
    const now = new Date().toISOString();
    await this._query(`
      MATCH (f:User_Fact {uid: $uid})
      SET f.valid_until = $now, f.retracted_at = $now
    `, { uid: factUid, now });
  }

  private _userUid(userId: string, platform: string): string {
    return `user:${platform}_${userId}`;
  }

  private _factUid(userId: string, platform: string, factType: string, value: string): string {
    // Stable uid: deterministic from user + type + normalized value
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
    return `fact:${platform}_${userId}_${factType}_${normalized}`;
  }

  private async _query(cypher: string, params: Record<string, unknown> = {}): Promise<unknown[][] | null> {
    const resp = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${this.auth}`,
      },
      body: JSON.stringify({ statements: [{ statement: cypher, parameters: params }] }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Neo4j HTTP error ${resp.status}: ${text}`);
    }

    const json = await resp.json() as Neo4jResponse;
    if (json.errors.length > 0) {
      throw new Error(`Neo4j error: ${json.errors[0].code} — ${json.errors[0].message}`);
    }

    return json.results[0]?.data.map(d => d.row) ?? null;
  }
}
