export function isJobNestedUnder(parentUrl: string, candidateUrl: string): boolean {
  try {
    const parent = new URL(parentUrl);
    const candidate = new URL(candidateUrl);
    const parentPath = parent.pathname.replace(/\/+$/, "");
    const candidatePath = candidate.pathname.replace(/\/+$/, "");

    return parent.origin === candidate.origin
      && candidatePath.startsWith(`${parentPath}/`);
  } catch {
    return false;
  }
}
