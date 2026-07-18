import type { User } from "@supabase/supabase-js";
import type { ProjectRole } from "../lib/roles.js";
import type { SlaPolicyDays } from "../lib/sla.js";

declare global {
  namespace Express {
    interface Request {
      user?: User;
      accessToken?: string;
      project?: {
        id: string;
        name: string;
        keyPrefix: string | null;
        ownerId: string;
        slaPolicyDays: SlaPolicyDays;
        myRole: ProjectRole;
      };
    }
  }
}

export {};
