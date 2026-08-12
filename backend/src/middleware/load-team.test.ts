import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// loadTeam is the enforcement seam for team-scoped routes. team_role() (SQL)
// is the source of truth for the caller's team role; the middleware fetches the
// team under RLS, guards that it belongs to the org in the URL, and reads the
// resolved role from the RPC. We mock the user-scoped client so its
// maybeSingle()/rpc() returns stand in for what the DB would return, and assert
// the attach-vs-404 decision. (accept_team_invite's org-viewer upsert is
// SQL-level and is covered by the migration, not here.)

let mockClient: unknown;
vi.mock("../lib/supabase.js", () => ({
  createUserScopedSupabaseClient: () => mockClient,
}));

const { loadTeam } = await import("./load-team.js");

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ORG_ID = "22222222-2222-2222-2222-222222222222";
const TEAM_ID = "33333333-3333-3333-3333-333333333333";

function makeClient(row: unknown, role: unknown) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: row, error: null }) };
            },
          };
        },
      };
    },
    rpc: async () => ({ data: role, error: null }),
  };
}

function fakeReq(params: Record<string, string>): Request {
  return { accessToken: "access-token", params } as unknown as Request;
}

describe("loadTeam", () => {
  beforeEach(() => {
    mockClient = undefined;
  });

  it("attaches the team when it is visible, in the URL's org, and team_role resolves", async () => {
    mockClient = makeClient({ id: TEAM_ID, name: "Platform", org_id: ORG_ID }, "admin");
    const req = fakeReq({ orgId: ORG_ID, teamId: TEAM_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadTeam(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.team?.id).toBe(TEAM_ID);
    expect(req.team?.orgId).toBe(ORG_ID);
    expect(req.team?.myRole).toBe("admin");
  });

  it("404s when the team is not visible (RLS returns no row)", async () => {
    mockClient = makeClient(null, null);
    const req = fakeReq({ orgId: ORG_ID, teamId: TEAM_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadTeam(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.team).toBeUndefined();
  });

  it("404s a cross-org team id addressed through the wrong org URL", async () => {
    // Team exists and is visible, but belongs to a different org than the path.
    mockClient = makeClient({ id: TEAM_ID, name: "Platform", org_id: OTHER_ORG_ID }, "admin");
    const req = fakeReq({ orgId: ORG_ID, teamId: TEAM_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadTeam(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.team).toBeUndefined();
  });

  it("404s when team_role resolves to null (no membership)", async () => {
    mockClient = makeClient({ id: TEAM_ID, name: "Platform", org_id: ORG_ID }, null);
    const req = fakeReq({ orgId: ORG_ID, teamId: TEAM_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadTeam(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.team).toBeUndefined();
  });
});
