import { describe, expect, test, afterEach } from "bun:test";
import { quinnHasReviewed, quinnLatestReviewState } from "../github.ts";
import { setFleetConfigForTesting, FLEET_DEFAULTS } from "../../fleet/fleet-config.ts";

afterEach(() => setFleetConfigForTesting());

const review = (login: string, state: string) => ({ user: { login }, state });

describe("reviewer-bot-login matching is fleet-config-driven (#798)", () => {
  test("default config matches protoquinn reviews", () => {
    const reviews = [review("protoquinn[bot]", "COMMENTED")];
    expect(quinnHasReviewed(reviews)).toBe(true);
    expect(quinnLatestReviewState(reviews)).toBe("COMMENTED");
  });

  test("a fork's reviewer bot is matched once fleet.yaml sets reviewerBotLogins", () => {
    setFleetConfigForTesting({ ...FLEET_DEFAULTS, reviewer: "carol", reviewerBotLogins: ["carolbot", "carolbot[bot]"] });
    const reviews = [review("carolbot[bot]", "CHANGES_REQUESTED")];
    expect(quinnHasReviewed(reviews)).toBe(true);
    expect(quinnLatestReviewState(reviews)).toBe("CHANGES_REQUESTED");
    // and it no longer matches the old hardcoded protoquinn
    expect(quinnHasReviewed([review("protoquinn[bot]", "APPROVED")])).toBe(false);
  });
});
