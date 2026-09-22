import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "./crypto.js";

describe("secret encryption", () => {
  it("round-trips unicode without exposing plaintext in the stored value", () => {
    const plaintext = "token-秘密-123";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it("uses a fresh nonce for the same plaintext", () => {
    expect(encrypt("same secret")).not.toBe(encrypt("same secret"));
  });

  it("rejects a tampered authentication tag", () => {
    const packed = Buffer.from(encrypt("sensitive"), "base64");
    packed[12] = packed[12]! ^ 1;
    expect(() => decrypt(packed.toString("base64"))).toThrow();
  });
});
