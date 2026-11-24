export interface FindingRevalidationIdentity {
  fingerprint: string;
  externalId: string | null;
  title: string;
  component: string | null;
  affectedPackages?: string | null;
  filePath: string | null;
  findingType: string | null;
  description: string | null;
  cves?: string | null;
}

function normalizeIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replaceAll("\\", "/").replace(/\s+/g, " ") ?? "";
}

function normalizeScanner(value: string | null | undefined): string {
  return normalizeIdentity(value).replace(/[\s_]+/g, "-");
}

function normalizePath(value: string | null | undefined): string {
  let path = value?.trim() ?? "";
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { /* Keep malformed paths distinct. */ }
  }
  path = path.replaceAll("\\", "/").replace(/^\/[a-z]:\//i, (drivePath) => drivePath.slice(1));
  const checkout = path.match(/^(?:\/?tmp\/bankai-scan-[^/]+\/repo|(?:[a-z]:)?\/?[^/]+_workspaces\/[^/]+)\/(.+)$/i);
  return (checkout?.[1] ?? path).replace(/^\.\//, "").toLowerCase();
}

function advisoryIds(value: string | null | undefined): Set<string> {
  return new Set((value ?? "").toLowerCase().match(/(?:cve-\d{4}-\d+|ghsa-[a-z0-9-]+|pysec-\d{4}-\d+)/g) ?? []);
}

/** Match the stored ticket finding to the same scanner result on the current default branch. */
export function findingStillPresent(finding: FindingRevalidationIdentity, scanFindings: FindingRevalidationIdentity[]): boolean {
  const scanner = normalizeScanner(finding.findingType);
  const component = normalizeIdentity(finding.component ?? finding.affectedPackages);
  const externalId = normalizeIdentity(finding.externalId);
  const filePath = normalizePath(finding.filePath);
  const title = normalizeIdentity(finding.title);
  const ids = advisoryIds([finding.externalId, finding.cves, finding.title, finding.description].filter(Boolean).join(" "));

  return scanFindings.some((current) => {
    if (current.fingerprint === finding.fingerprint) return true;
    if (normalizeScanner(current.findingType) !== scanner) return false;

    const currentComponent = normalizeIdentity(current.component);
    const currentId = normalizeIdentity(current.externalId);
    const currentPath = normalizePath(current.filePath);
    const currentIds = advisoryIds([current.externalId, current.cves, current.title, current.description].filter(Boolean).join(" "));
    if ([...ids].some((id) => currentIds.has(id)) && component && currentComponent === component) return true;

    if (externalId && currentId === externalId && (!component || currentComponent === component)) {
      return ["pip-audit", "npm-audit", "trivy", "osv"].includes(scanner) || !filePath || currentPath === filePath;
    }

    if (scanner === "pip-audit" && component && (!currentComponent || currentComponent === component)) {
      const titleAnchor = title.replace(/…|\.\.\.$/, "").slice(0, 100);
      return titleAnchor.length >= 40
        && (normalizeIdentity(current.title).includes(titleAnchor) || normalizeIdentity(current.description).includes(titleAnchor));
    }
    return false;
  });
}
