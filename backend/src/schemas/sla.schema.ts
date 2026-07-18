import { z } from "zod";

const days = z.number().int().min(1, "Must be at least 1 day").max(3650, "Must be 3650 days or fewer");

export const updateSlaPolicySchema = z.object({
  critical: days,
  high: days,
  medium: days,
  low: days,
});

export type UpdateSlaPolicyInput = z.infer<typeof updateSlaPolicySchema>;
