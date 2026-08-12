import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// These cover the role-resolution edge cases the org hierarchy introduces.
// project_role()/org_role() (SQL) are the single source of truth for a user's
// effective role — project_role() already returns MAX(project, team, org), so
// the API layer never recomputes it, it just trusts the RPC. The enforcement
// seam is the loader middleware: it fetches the row under RLS and reads the
// resolved role from the RPC. We mock the user-scoped client so its
// maybeSingle()/rpc() returns represent exactly what the DB would return in
// each scenario, and assert the access decision (attach vs 404) the middleware
// makes off it.

let mockClient: unknown;
vi.mock("../lib/supabase.js", () => ({
  createUserScopedSupabaseClient: () => mockClient,
}));

const { loadProject } = await import("./load-project.js");
const { loadOrg } = await import("./load-org.js");

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const ORG_ID = "22222222-2222-2222-2222-222222222222";
const ME = "33333333-3333-3333-3333-333333333333";
const SOMEONE_ELSE = "44444444-4444-4444-4444-444444444444";

// A minimal stand-in for the user-scoped Supabase client covering the exact
// call chain both loaders use: from(table).select(cols).eq(col, val)
// .maybeSingle(), then rpc(fnName, args).
function makeClient(row: unknown, role: unknown) {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              };
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

describe("loadProject role resolution", () => {
  beforeEach(() => {
    mockClient = undefined;
  });

  it("grants access when the user's org role exceeds their (absent) project role", async () => {
    // The user is not a direct project_members row and does not own the
    // project (owner_id is someone else). They gain access purely because
    // project_role() folded in their org membership -> 'admin'. RLS therefore
    // returns the row, and the RPC returns the elevated role.
    mockClient = makeClient(
      {
        id: PROJECT_ID,
        name: "Acme App",
        key_prefix: "AA",
        owner_id: SOMEONE_ELSE,
        sla_critical_days: 7,
        sla_high_days: 14,
        sla_medium_days: 30,
        sla_low_days: 90,
      },
      "admin",
    );
    const req = fakeReq({ projectId: PROJECT_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadProject(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.project?.myRole).toBe("admin");
    // Proves the access is inherited, not from ownership.
    expect(req.project?.ownerId).toBe(SOMEONE_ELSE);
  });

  it("revokes inherited access once the org membership is gone (RLS hides the row)", async () => {
    // After removing the org member, project_role() drops back to null, so the
    // projects SELECT policy no longer returns the row at all.
    mockClient = makeClient(null, null);
    const req = fakeReq({ projectId: PROJECT_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadProject(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.project).toBeUndefined();
  });

  it("revokes access when the role RPC itself resolves to null (defense in depth)", async () => {
    // Even if a row were somehow visible, a null resolved role must 404 — the
    // loader's second gate, exercising the role branch directly.
    mockClient = makeClient({ id: PROJECT_ID, name: "Acme App", key_prefix: "AA", owner_id: SOMEONE_ELSE, sla_critical_days: 7, sla_high_days: 14, sla_medium_days: 30, sla_low_days: 90 }, null);
    const req = fakeReq({ projectId: PROJECT_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadProject(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.project).toBeUndefined();
  });
});

describe("loadOrg role resolution", () => {
  beforeEach(() => {
    mockClient = undefined;
  });

  it("attaches the org for a member whose org_role resolves to a real role", async () => {
    mockClient = makeClient({ id: ORG_ID, name: "Acme", owner_id: SOMEONE_ELSE }, "viewer");
    const req = fakeReq({ orgId: ORG_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadOrg(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.org?.myRole).toBe("viewer");
    expect(req.org?.id).toBe(ORG_ID);
  });

  it("404s a removed member — org_role resolves to null", async () => {
    mockClient = makeClient(null, null);
    const req = fakeReq({ orgId: ORG_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadOrg(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    expect(req.org).toBeUndefined();
  });

  it("uses ME only as the authenticated caller — access is decided by the resolved role, not identity", async () => {
    // Sanity guard that the loader keys off the RPC result, not req identity:
    // same caller, role present -> attached.
    mockClient = makeClient({ id: ORG_ID, name: "Acme", owner_id: ME }, "owner");
    const req = fakeReq({ orgId: ORG_ID });
    const next = vi.fn() as unknown as NextFunction;

    await loadOrg(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.org?.myRole).toBe("owner");
  });
});
