/**
 * FunctionExecutor — wraps a plain async function as an IExecutor.
 *
 * Use when no agent or external call is needed — e.g. data transforms,
 * in-process state mutations, or test stubs.
 */

import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

export type SkillFn = (req: SkillRequest) => Promise<SkillResult>;

export class FunctionExecutor implements IExecutor {
  readonly type = "function";

  constructor(private readonly fn: SkillFn) {}

  execute(req: SkillRequest): Promise<SkillResult> {
    return this.fn(req);
  }
}
