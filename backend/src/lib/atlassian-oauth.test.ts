import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Atlassian OAuth state", () => {
  beforeEach(() => {
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "test-atlassian-client";
    process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = "test-atlassian-secret";
    vi.resetModules();
  });

  it("signs project-bound authorization state and rejects tampering", async () => {
    const { createJiraOAuthAuthorizationUrl, parseJiraOAuthState } = await import("./atlassian-oauth.js");
    const url = new URL(createJiraOAuthAuthorizationUrl("project-1", "user-1"));
    expect(url.origin).toBe("https://auth.atlassian.com");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("response_type")).toBe("code");

    const state = url.searchParams.get("state")!;
    expect(parseJiraOAuthState(state)).toMatchObject({ projectId: "project-1", userId: "user-1" });
    const [encoded, signature] = state.split(".");
    expect(parseJiraOAuthState(`${encoded!.startsWith("A") ? "B" : "A"}${encoded!.slice(1)}.${signature}`)).toBeNull();
    expect(parseJiraOAuthState(`${state}.extra`)).toBeNull();
  });

  it("rejects malformed and expired state", async () => {
    const { parseJiraOAuthState } = await import("./atlassian-oauth.js");
    expect(parseJiraOAuthState("not-a-signed-state")).toBeNull();
    const encoded = Buffer.from(JSON.stringify({ projectId: "p", userId: "u", expiresAt: Date.now() - 1, nonce: "n" })).toString("base64url");
    const key = Buffer.from(process.env.TOKEN_ENC_KEY!, "base64");
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    expect(parseJiraOAuthState(`${encoded}.${signature}`)).toBeNull();
  });
});
