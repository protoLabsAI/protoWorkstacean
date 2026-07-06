import { describe, expect, test } from "bun:test";
import { submitPrReview } from "../github-review.ts";

const getToken = async () => "tok";

describe("submitPrReview — headSha validation", () => {
  test("throws if headSha is empty string", async () => {
    await expect(
      submitPrReview(getToken, "o", "r", 1, "", "APPROVE", "body"),
    ).rejects.toThrow(/commit_id \(headSha\) is required/);
  });
});
