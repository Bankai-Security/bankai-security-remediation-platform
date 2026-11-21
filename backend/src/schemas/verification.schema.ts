import { z } from "zod";

export const verificationProviderSchema = z.object({
  provider: z.enum(["none", "jenkins", "hosted_ci"]),
});
