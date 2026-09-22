import { describe, expect, it } from "vitest";
import { changePasswordSchema, loginSchema, signupSchema } from "./auth.schema.js";

describe("authentication request schemas", () => {
  it("normalizes a valid signup without retaining surrounding whitespace", () => {
    const result = signupSchema.parse({
      fullName: "  Ada Lovelace  ",
      email: "ADA@EXAMPLE.COM",
      password: "SecurePass1",
    });
    expect(result).toEqual({ fullName: "Ada Lovelace", email: "ada@example.com", password: "SecurePass1" });
  });

  it("rejects whitespace around an email instead of accepting an ambiguous identity", () => {
    expect(signupSchema.safeParse({ fullName: "Ada", email: " ada@example.com ", password: "SecurePass1" }).success).toBe(false);
  });

  it.each([
    ["short", "short"],
    ["missing uppercase", "securepass1"],
    ["missing lowercase", "SECUREPASS1"],
    ["missing number", "SecurePassword"],
  ])("rejects a %s password", (_case, password) => {
    expect(signupSchema.safeParse({ fullName: "Ada", email: "ada@example.com", password }).success).toBe(false);
  });

  it("rejects malformed login input", () => {
    const result = loginSchema.safeParse({ email: "not-an-email", password: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["email", "password"]);
  });

  it("requires a different valid new password shape", () => {
    expect(changePasswordSchema.safeParse({ currentPassword: "", newPassword: "weak" }).success).toBe(false);
    expect(changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "NewPassword1" }).success).toBe(true);
  });
});
