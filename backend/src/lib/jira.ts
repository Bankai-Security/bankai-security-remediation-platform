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
