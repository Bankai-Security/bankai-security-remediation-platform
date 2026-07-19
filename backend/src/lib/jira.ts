import type { Severity, TicketStatus } from "./pipeline-types.js";

export interface JiraCredentials {
  site: string;
  email: string;
  apiToken: string;
}

export class JiraApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
  }
}

function baseUrl(site: string): string {
  return `https://${site.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

function jiraFetch(creds: JiraCredentials, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl(creds.site)}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export async function verifyConnection(creds: JiraCredentials, projectKey: string): Promise<void> {
  let me: Response;
  try {
    me = await jiraFetch(creds, "/rest/api/3/myself");
  } catch {
    throw new JiraApiError("Could not reach that Jira site — check the site URL.");
  }
  if (me.status === 401) throw new JiraApiError("Invalid email or API token.", 401);
  if (!me.ok) throw new JiraApiError(`Could not reach Jira (status ${me.status}).`, me.status);

  const proj = await jiraFetch(creds, `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  if (proj.status === 404) throw new JiraApiError(`Project key "${projectKey}" was not found on this site.`, 404);
  if (!proj.ok) throw new JiraApiError(`Could not verify the project key (status ${proj.status}).`, proj.status);
}

// Jira API v3 requires the `description` field as Atlassian Document
// Format, not plain text — this wraps each non-empty line as a paragraph.
function toADF(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
  };
}

// Default Jira Cloud priority scheme.
const SEVERITY_TO_PRIORITY: Record<Severity, string> = {
  Critical: "Highest",
  High: "High",
  Medium: "Medium",
  Low: "Low",
};

export interface FindingSummary {
  id: string;
  fingerprint: string;
  externalId: string | null;
  title: string;
  severity: Severity;
  cvssScore: number | null;
  cwe: string | null;
  component: string | null;
  filePath: string | null;
  findingType: string | null;
  sourceStatus: string | null;
  dateFound: string | null;
  description: string | null;
  fixAvailable: string | null;
  sourceUrl: string | null;
}

// Builds a self-contained issue description so the finding can be
// remediated from the Jira ticket alone, without needing to cross-reference
// Bankai — every column shown in the findings/AI Triage table is included.
// The Fingerprint line is a portable identity marker: unlike `ID`, which is
// a UUID scoped to one Bankai project's `findings` table, `fingerprint` is
// content-derived (title/component/file, or CWE/file/line-bucket) so the
// *same* underlying vulnerability scanned into a different Bankai project
// pointed at this same Jira project produces the same value — that's what
// lets reconcileJiraTickets() (ticketing.ts) recognize and reuse this issue
// instead of creating a duplicate.
export function buildFindingDescription(f: FindingSummary): string {
  return [
    `ID: ${f.externalId ?? f.id}`,
    `Fingerprint: ${f.fingerprint}`,
    `Title: ${f.title}`,
    `Severity: ${f.severity}`,
    `CVSS Score: ${f.cvssScore ?? "—"}`,
    `CWE: ${f.cwe ?? "—"}`,
    `Component: ${f.component ?? "—"}`,
    `File Path: ${f.filePath ?? "—"}`,
    `Type: ${f.findingType ?? "—"}`,
    `Status: ${f.sourceStatus ?? "—"}`,
    `Date Found: ${f.dateFound ?? "—"}`,
    `Fix Available: ${f.fixAvailable ?? "—"}`,
    `Source: ${f.sourceUrl ?? "—"}`,
    `Description: ${f.description ?? "—"}`,
  ].join("\n");
}

export interface CreateIssueInput {
  projectKey: string;
  title: string;
  description: string;
  severity: Severity;
  dueDate: string | null;
}

export interface CreatedIssue {
  key: string;
  url: string;
}

export async function createIssue(creds: JiraCredentials, input: CreateIssueInput): Promise<CreatedIssue> {
  const res = await jiraFetch(creds, "/rest/api/3/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: input.projectKey },
        summary: input.title,
        issuetype: { name: "Bug" },
        description: toADF(input.description),
        priority: { name: SEVERITY_TO_PRIORITY[input.severity] },
        ...(input.dueDate ? { duedate: input.dueDate } : {}),
      },
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason =
      (Array.isArray(body.errorMessages) ? body.errorMessages[0] : undefined) ??
      (body.errors && typeof body.errors === "object" ? Object.values(body.errors as Record<string, unknown>)[0] : undefined);
    throw new JiraApiError(typeof reason === "string" ? reason : `Jira issue creation failed (status ${res.status}).`, res.status);
  }

  const created = (await res.json()) as { key: string };
  return { key: created.key, url: `${baseUrl(creds.site)}/browse/${created.key}` };
}

// Scrum projects put newly created issues in the Backlog, not the active
// sprint's Board, until something explicitly moves them there. Kanban
// projects have no sprints at all. Both are normal — this best-effort
// lookup finds the active sprint (if any) so callers can add new issues to
// it; a project with no board/active sprint just returns null and callers
// skip the move silently.
export async function getActiveSprintId(creds: JiraCredentials, projectKey: string): Promise<number | null> {
  try {
    const boardsRes = await jiraFetch(creds, `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}`);
    if (!boardsRes.ok) return null;
    const { values: boards } = (await boardsRes.json()) as { values: { id: number }[] };
    const board = boards[0];
    if (!board) return null;

    const sprintsRes = await jiraFetch(creds, `/rest/agile/1.0/board/${board.id}/sprint?state=active`);
    if (!sprintsRes.ok) return null;
    const { values: sprints } = (await sprintsRes.json()) as { values: { id: number }[] };
    return sprints[0]?.id ?? null;
  } catch {
    return null;
  }
}

// Never throws — same best-effort contract as transitionIssue.
export async function addIssueToSprint(creds: JiraCredentials, sprintId: number, issueKey: string): Promise<boolean> {
  try {
    const res = await jiraFetch(creds, `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: "POST",
      body: JSON.stringify({ issues: [issueKey] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface BranchCommentResult {
  ok: boolean;
  status?: number | undefined;
  message?: string | undefined;
}

// Never throws — same best-effort contract as addIssueToSprint. Posts a
// comment linking the remediation branch so it's visible from the Jira
// ticket itself, not just Bankai. Returns the failure reason (rather than a
// plain boolean) so callers can log why, instead of a silent no-op.
export async function addBranchComment(
  creds: JiraCredentials,
  issueKey: string,
  branch: { name: string; url: string },
): Promise<BranchCommentResult> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Remediation branch created: " },
                { type: "text", text: branch.name, marks: [{ type: "link", attrs: { href: branch.url } }] },
              ],
            },
          ],
        },
      }),
    });
    if (res.ok) return { ok: true };

    const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, unknown> };
    const reason =
      body.errorMessages?.[0] ?? (body.errors && typeof body.errors === "object" ? Object.values(body.errors)[0] : undefined);
    return { ok: false, status: res.status, message: typeof reason === "string" ? reason : undefined };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Never throws — same best-effort contract as addBranchComment. A 404 counts
// as success (the issue is already gone either way), so callers cleaning up
// a batch of issues don't need to special-case ones deleted directly in Jira.
export async function deleteIssue(creds: JiraCredentials, issueKey: string): Promise<boolean> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

// Best-effort target-status name candidates per Bankai ticket status —
// Jira workflows vary, so this matches by name rather than assuming ids.
const STATUS_TO_JIRA: Record<TicketStatus, string[]> = {
  "To Do": ["To Do", "Open", "Backlog"],
  "In Progress": ["In Progress"],
  "In Review": ["In Review", "Review"],
  Done: ["Done", "Closed", "Resolved"],
};

interface JiraTransition {
  id: string;
  name: string;
  to?: { name: string };
}

// Never throws — a status change in Bankai must not fail because the
// linked Jira workflow doesn't have a matching transition available.
export async function transitionIssue(creds: JiraCredentials, issueKey: string, targetStatus: TicketStatus): Promise<boolean> {
  try {
    const listRes = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    if (!listRes.ok) return false;

    const { transitions } = (await listRes.json()) as { transitions: JiraTransition[] };
    const candidates = STATUS_TO_JIRA[targetStatus];
    const match = transitions.find((t) => candidates.includes(t.to?.name ?? t.name));
    if (!match) return false;

    const doRes = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    });
    return doRes.ok;
  } catch {
    return false;
  }
}

// Reverse of STATUS_TO_JIRA — maps a Jira status name back to the Bankai
// status it corresponds to, so a sync run can pull status changes made
// directly in Jira (not just ones Bankai pushed itself).
const JIRA_STATUS_TO_BANKAI: Record<string, TicketStatus> = Object.fromEntries(
  (Object.entries(STATUS_TO_JIRA) as [TicketStatus, string[]][]).flatMap(([bankaiStatus, jiraNames]) =>
    jiraNames.map((name) => [name.toLowerCase(), bankaiStatus]),
  ),
);

export interface IssueSnapshot {
  exists: boolean;
  // null if the issue exists but its current Jira status doesn't map to a
  // known Bankai status (an unrecognized custom workflow state).
  status: TicketStatus | null;
}

// Never throws — a stale/unreachable link must not fail the surrounding
// sync request. Only an explicit 404 counts as "deleted"; any other
// failure (network blip, auth hiccup) reports the issue as still existing
// so a sync run never mistakenly recreates a duplicate over a transient
// error.
export async function getIssueSnapshot(creds: JiraCredentials, issueKey: string): Promise<IssueSnapshot> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=status`);
    if (res.status === 404) return { exists: false, status: null };
    if (!res.ok) return { exists: true, status: null };

    const body = (await res.json()) as { fields?: { status?: { name?: string } } };
    const jiraStatusName = body.fields?.status?.name;
    const status = jiraStatusName ? (JIRA_STATUS_TO_BANKAI[jiraStatusName.toLowerCase()] ?? null) : null;
    return { exists: true, status };
  } catch {
    return { exists: true, status: null };
  }
}

export interface UpdateIssueInput {
  title: string;
  description: string;
  severity: Severity;
  dueDate: string | null;
}

// Never throws — same best-effort contract as transitionIssue/deleteIssue.
// PUT /rest/api/3/issue/{key} returns 204 with no body on success. Used to
// push a Bankai ticket's fields onto an already-created Jira issue when the
// underlying finding changes on a rescan (unlike createIssue, this can be
// called repeatedly against the same issue).
export async function updateIssue(creds: JiraCredentials, issueKey: string, input: UpdateIssueInput): Promise<boolean> {
  try {
    const res = await jiraFetch(creds, `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: "PUT",
      body: JSON.stringify({
        fields: {
          summary: input.title,
          description: toADF(input.description),
          priority: { name: SEVERITY_TO_PRIORITY[input.severity] },
          duedate: input.dueDate,
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface JiraIssueSummary {
  key: string;
  url: string;
  // null if the issue's description has no parseable "Fingerprint: <value>"
  // line — e.g. a manually created issue, or one predating this feature.
  fingerprint: string | null;
  // The rest are only populated when `fingerprint` is non-null — parsing an
  // issue that can never be linked or imported anyway is wasted work.
  // Recovered from the issue's summary/description (the inverse of
  // buildFindingDescription's format below) so reconcileJiraTickets()
  // (ticketing.ts) can synthesize a brand-new local finding for an issue
  // that has no match in this Bankai project — e.g. one created by a
  // different Bankai project/account pointed at the same Jira project.
  title?: string | undefined;
  service?: string | null;
  severity?: Severity | null;
  cvssScore?: number | null;
  cwe?: string | null;
  component?: string | null;
  filePath?: string | null;
  findingType?: string | null;
  sourceStatus?: string | null;
  dateFound?: string | null;
  description?: string | null;
  fixAvailable?: string | null;
  sourceUrl?: string | null;
}

const FINGERPRINT_LINE = /^Fingerprint:\s*(\S+)/m;
const EM_DASH = "—"; // the "—" buildFindingDescription() writes for a missing value

// Reads one "Label: value" line out of buildFindingDescription()'s format —
// the inverse of that function. Returns null for a missing line or the
// em-dash sentinel it writes for a null field.
function parseLabelLine(text: string, label: string): string | null {
  const match = new RegExp(`^${label}:\\s*(.*)$`, "m").exec(text);
  if (!match) return null;
  const value = match[1]!.trim();
  return value === "" || value === EM_DASH ? null : value;
}

// Description is always the last field buildFindingDescription() writes, and
// may itself contain embedded newlines (each became its own ADF paragraph,
// indistinguishable from a new "line" once adfToPlainText rejoins them) — so
// unlike every other label this one must capture to end-of-string, not
// end-of-line, or everything after the first line would be lost.
function parseDescriptionLine(text: string): string | null {
  const match = /^Description:\s*([\s\S]*)$/m.exec(text);
  if (!match) return null;
  const value = match[1]!.trim();
  return value === "" || value === EM_DASH ? null : value;
}

const VALID_SEVERITIES: readonly string[] = ["Critical", "High", "Medium", "Low"];

interface ParsedFindingFields {
  title: string | null;
  severity: Severity | null;
  cvssScore: number | null;
  cwe: string | null;
  component: string | null;
  filePath: string | null;
  findingType: string | null;
  sourceStatus: string | null;
  dateFound: string | null;
  description: string | null;
  fixAvailable: string | null;
  sourceUrl: string | null;
}

function parseFindingFieldsFromDescription(text: string): ParsedFindingFields {
  const severityRaw = parseLabelLine(text, "Severity");
  const cvssRaw = parseLabelLine(text, "CVSS Score");
  const cvssParsed = cvssRaw ? Number(cvssRaw) : NaN;

  return {
    title: parseLabelLine(text, "Title"),
    severity: severityRaw && VALID_SEVERITIES.includes(severityRaw) ? (severityRaw as Severity) : null,
    cvssScore: Number.isFinite(cvssParsed) ? cvssParsed : null,
    cwe: parseLabelLine(text, "CWE"),
    component: parseLabelLine(text, "Component"),
    filePath: parseLabelLine(text, "File Path"),
    findingType: parseLabelLine(text, "Type"),
    sourceStatus: parseLabelLine(text, "Status"),
    dateFound: parseLabelLine(text, "Date Found"),
    description: parseDescriptionLine(text),
    fixAvailable: parseLabelLine(text, "Fix Available"),
    sourceUrl: parseLabelLine(text, "Source"),
  };
}

// Inverse of the `[${service}] ${title}` summary format written at
// ticket.controller.ts:220 / ticketing.ts:250. The literal "Unassigned"
// bracket value is a display fallback, not a real service name, so it maps
// back to null rather than polluting the project's service list.
function parseSummary(summary: string): { service: string | null; title: string } {
  const match = /^\[(.+?)\]\s*(.*)$/.exec(summary);
  if (!match) return { service: null, title: summary.trim() };
  const service = match[1]!.trim();
  return { service: service === "Unassigned" ? null : service, title: match[2]!.trim() };
}

// Best-effort ADF -> plain text, just enough to recover the "Label: value"
// lines buildFindingDescription() writes — not a general ADF renderer.
function adfToPlainText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (Array.isArray(n.content)) {
    const inner = n.content.map(adfToPlainText).join("");
    return n.type === "paragraph" ? `${inner}\n` : inner;
  }
  return "";
}

// Lists every issue in the connected Jira project along with the
// fingerprint (if any) parsed out of its description — plus, when a
// fingerprint is present, every other finding field recoverable from the
// description/summary — so reconcileJiraTickets() (ticketing.ts) can either
// link an already-existing issue to a matching local finding, or synthesize
// a brand-new one when no local match exists. Never throws —
// returns whatever was collected before any failure (including [] if the
// very first page fails), so a search-endpoint outage degrades to "no
// reconciliation this run" rather than breaking the caller.
//
// NOTE: uses POST /rest/api/3/search/jql with cursor-based pagination
// (nextPageToken), which superseded the older startAt/total-based
// /rest/api/3/search endpoint. Verify this against a live Jira Cloud site
// before relying on it — Atlassian's search endpoint/pagination contract
// has changed over time and the exact current shape should be confirmed,
// not assumed. Written defensively (capped page count, fails closed on any
// shape mismatch) so an incorrect assumption here degrades gracefully
// rather than looping or crashing.
export async function searchIssuesInProject(creds: JiraCredentials, projectKey: string): Promise<JiraIssueSummary[]> {
  const results: JiraIssueSummary[] = [];
  let nextPageToken: string | undefined;
  const jql = `project = "${projectKey}" ORDER BY created DESC`;
  const MAX_PAGES = 50; // 50 * 100 = 5,000 issues ceiling

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await jiraFetch(creds, "/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql,
          maxResults: 100,
          fields: ["description", "summary"],
          ...(nextPageToken ? { nextPageToken } : {}),
        }),
      });
      if (!res.ok) return results;

      const body = (await res.json()) as {
        issues?: { key: string; fields?: { description?: unknown; summary?: string } }[];
        nextPageToken?: string;
        isLast?: boolean;
      };
      for (const issue of body.issues ?? []) {
        const text = adfToPlainText(issue.fields?.description);
        const match = FINGERPRINT_LINE.exec(text);
        const fingerprint = match?.[1] ?? null;
        const url = `${baseUrl(creds.site)}/browse/${issue.key}`;
        if (!fingerprint) {
          results.push({ key: issue.key, url, fingerprint: null });
          continue;
        }

        const fields = parseFindingFieldsFromDescription(text);
        const summary = parseSummary(issue.fields?.summary ?? "");
        results.push({
          key: issue.key,
          url,
          fingerprint,
          title: summary.title || fields.title || undefined,
          service: summary.service,
          severity: fields.severity,
          cvssScore: fields.cvssScore,
          cwe: fields.cwe,
          component: fields.component,
          filePath: fields.filePath,
          findingType: fields.findingType,
          sourceStatus: fields.sourceStatus,
          dateFound: fields.dateFound,
          description: fields.description,
          fixAvailable: fields.fixAvailable,
          sourceUrl: fields.sourceUrl,
        });
      }
      if (body.isLast || !body.nextPageToken) return results;
      nextPageToken = body.nextPageToken;
    }
    return results;
  } catch {
    return results;
  }
}
