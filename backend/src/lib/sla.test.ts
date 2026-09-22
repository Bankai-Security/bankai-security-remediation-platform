import { describe, expect, it } from "vitest";
import { computeSlaDueDate, computeSlaStatus, ttrStatusLabel, type SlaPolicyDays } from "./sla.js";

const policy: SlaPolicyDays = { Critical: 1, High: 5, Medium: 10, Low: 20 };

describe("SLA calculations", () => {
  it("calculates due dates in UTC across month boundaries", () => {
    expect(computeSlaDueDate("High", new Date("2026-01-29T23:30:00Z"), policy)).toBe("2026-02-03");
  });

  it.each([
    [null, "2026-01-01T00:00:00Z", "On track"],
    ["2026-01-09", "2026-01-10T00:00:00Z", "Missed"],
    ["2026-01-11", "2026-01-10T00:00:00Z", "Approaching"],
    ["2026-01-15", "2026-01-10T00:00:00Z", "On track"],
  ] as const)("classifies due date %s", (dueDate, now, expected) => {
    expect(computeSlaStatus("High", dueDate, policy, new Date(now))).toBe(expected);
  });

  it("maps internal states to ticket-facing labels", () => {
    expect(ttrStatusLabel("Missed")).toBe("Target Missed");
    expect(ttrStatusLabel("Approaching")).toBe("Approaching Target");
    expect(ttrStatusLabel("On track")).toBe("On Track");
  });
});
