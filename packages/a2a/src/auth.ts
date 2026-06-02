/**
 * Auth scheme — the protoLabs convention for authenticating outbound A2A
 * requests, and for advertising the matching security scheme on the AgentCard.
 *
 * Two schemes are in use across the fleet:
 *   "apiKey" — credential sent as `X-API-Key: <value>` (the fleet default).
 *   "bearer" — credential sent as `Authorization: Bearer <value>`.
 *
 * "hmac" is reserved for HMAC-signed requests handled by an extension
 * interceptor rather than a static header, so this helper leaves it untouched.
 */

import type { SecurityScheme } from "@a2a-js/sdk";

export type A2AAuthScheme = "apiKey" | "bearer" | "hmac";

/** Header name the apiKey scheme stamps. */
export const API_KEY_HEADER = "X-API-Key";

/**
 * Stamp the auth header for `scheme` + `value` onto a Headers object, in place.
 * No-op when `value` is empty or the scheme is handled elsewhere ("hmac").
 */
export function stampAuthHeader(
  headers: Headers,
  scheme: A2AAuthScheme,
  value: string,
): void {
  if (!value) return;
  if (scheme === "bearer") {
    headers.set("Authorization", `Bearer ${value}`);
  } else if (scheme === "apiKey") {
    headers.set(API_KEY_HEADER, value);
  }
  // "hmac" is stamped by an extension interceptor, not here.
}

/**
 * Build the AgentCard `securitySchemes` entry that matches a given auth scheme.
 * Returns the scheme keyed by a stable name (`apiKey` / `bearer`) so the card's
 * `securityRequirements` can reference it. protoLabs cards advertise exactly
 * the scheme they enforce, so peers know how to authenticate.
 */
export function securitySchemeFor(scheme: A2AAuthScheme): Record<string, SecurityScheme> {
  if (scheme === "bearer") {
    return {
      bearer: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            description: "protoLabs fleet bearer token",
            scheme: "Bearer",
            bearerFormat: "",
          },
        },
      },
    };
  }
  // apiKey (default) — "hmac" has no static card scheme, so it also maps here.
  return {
    apiKey: {
      scheme: {
        $case: "apiKeySecurityScheme",
        value: {
          description: "protoLabs fleet API key",
          location: "header",
          name: API_KEY_HEADER,
        },
      },
    },
  };
}
