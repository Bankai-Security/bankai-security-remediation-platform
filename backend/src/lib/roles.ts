import { HttpError } from "./http-error.js";

export type ProjectRole = "owner" | "admin" | "editor" | "viewer";

// Belt-and-suspenders alongside RLS: two bugs already shipped this session
// (a missing scans UPDATE policy, a missing tickets DELETE policy) from
// trusting RLS to silently and safely no-op a disallowed write. A blocked
// write should be a loud, diagnosable 403 from the controller, not a
// zero-row mutation the caller has to notice on their own.
export function requireRole(myRole: ProjectRole, allowed: ProjectRole[]): void {
  if (!allowed.includes(myRole)) {
    throw new HttpError(403, "You do not have permission to perform this action.");
  }
}
