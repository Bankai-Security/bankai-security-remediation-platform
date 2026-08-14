import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { assertInviteRateLimit, resendInvite } from "./invites.js";

// The invite lib is the shared guard behind all three invite scopes
// (project/org/team), so its two behaviors — the per-user hourly throttle and
// the revoke-then-reissue resend — are worth pinning down directly. The
// Supabase client is mocked to return exactly what PostgREST would.

function rateLimitClient(count: number | null, error: unknown = null) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                gt: async () => ({ count, error }),
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("assertInviteRateLimit", () => {
  it("allows a user under the hourly limit", async () => {
    await expect(assertInviteRateLimit(rateLimitClient(19), "org_invites", "user-1")).resolves.toBeUndefined();
  });

  it("throws 429 once the hourly limit is reached", async () => {
    await expect(assertInviteRateLimit(rateLimitClient(20), "org_invites", "user-1")).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("treats a null count as zero rather than blocking", async () => {
    await expect(assertInviteRateLimit(rateLimitClient(null), "team_invites", "user-1")).resolves.toBeUndefined();
  });
});

// Captures the update/insert payloads so the test can assert the old invite is
// revoked and the new one inherits email+role.
function resendClient(opts: { revoked: { email: string; role: string }[] | null; insertFails?: boolean }) {
  const calls: { revokedStatus?: string; inserted?: Record<string, unknown> } = {};

  const client = {
    from() {
      return {
        update(payload: { status: string }) {
          calls.revokedStatus = payload.status;
          return {
            eq() {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        select: async () => ({ data: opts.revoked, error: null }),
                      };
                    },
                  };
                },
              };
            },
          };
        },
        insert(payload: Record<string, unknown>) {
          calls.inserted = payload;
          return {
            select() {
              return {
                single: async () =>
                  opts.insertFails
                    ? { data: null, error: { message: "insert failed" } }
                    : {
                        data: {
                          id: "invite-2",
                          token: "token-2",
                          email: payload.email,
                          role: payload.role,
                          created_at: "2026-08-13T00:00:00.000Z",
                          expires_at: "2026-08-27T00:00:00.000Z",
                        },
                        error: null,
                      },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

const input = {
  table: "org_invites" as const,
  scopeColumn: "org_id" as const,
  scopeId: "org-1",
  inviteId: "invite-1",
  invitedBy: "user-1",
};

describe("resendInvite", () => {
  it("revokes the old invite and issues a fresh one with the same email and role", async () => {
    const { client, calls } = resendClient({ revoked: [{ email: "person@example.com", role: "editor" }] });

    const fresh = await resendInvite(client, input);

    expect(calls.revokedStatus).toBe("revoked");
    expect(calls.inserted).toEqual(
      expect.objectContaining({ org_id: "org-1", email: "person@example.com", role: "editor", invited_by: "user-1" }),
    );
    // A new token is what makes the old link dead.
    expect(fresh.token).toBe("token-2");
    expect(fresh.expires_at).toBe("2026-08-27T00:00:00.000Z");
  });

  it("404s when there is no matching pending invite", async () => {
    const { client } = resendClient({ revoked: [] });

    await expect(resendInvite(client, input)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("reports the revoked-but-not-reissued case explicitly", async () => {
    // The two writes aren't a transaction; if the insert fails the admin needs
    // to know the old invite is already dead.
    const { client } = resendClient({ revoked: [{ email: "person@example.com", role: "viewer" }], insertFails: true });

    await expect(resendInvite(client, input)).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining("revoked"),
    });
  });
});
