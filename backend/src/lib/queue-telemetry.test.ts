import { describe, expect, it } from "vitest";
import { waitingAgeMs } from "./queue-telemetry.js";

describe("waitingAgeMs", () => {
  it("calculates age from the queued timestamp", () => {
    expect(waitingAgeMs(1_000, 4_000)).toBe(3_000);
  });

  it("omits missing, invalid, and future timestamps", () => {
    expect(waitingAgeMs(undefined, 4_000)).toBeNull();
    expect(waitingAgeMs(Number.NaN, 4_000)).toBeNull();
    expect(waitingAgeMs(5_000, 4_000)).toBeNull();
  });
});
