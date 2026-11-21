<p align="center">
  <img src="frontend/src/assets/bankai-wordmark.svg" alt="Bankai" width="240" />
</p>

<h3 align="center">Vulnerability Remediation Platform</h3>

<p align="center">
  Scan. Triage. Ticket. Fix. Review. — a security workflow that turns findings into pull requests<br/>
  your team reviews and merges.
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D22.21-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white">
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black">
  <img alt="Express" src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white">
  <img alt="Supabase" src="https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ECF8E?logo=supabase&logoColor=white">
  <img alt="Status" src="https://img.shields.io/badge/status-active%20development-orange">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

## Table of Contents

- [Overview](#overview)
- [Core Capabilities](#core-capabilities)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Repository Structure](#repository-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Data Model](#data-model)
- [API Surface](#api-surface)
- [Security Architecture](#security-architecture)
- [CI/CD](#cicd)
- [Deployment](#deployment)
- [Project Status](#project-status)
- [License](#license)

---

## Overview

**Bankai** is a security remediation platform that scans connected repositories and ingests
scanner reports, then normalizes findings, supports triage and SLA tracking, and can generate
a code fix and open a pull request. A developer reviews and merges every remediation pull
request manually.

The platform is organized around **projects** (one per repository/application under
management), each with its own connected GitHub repository, optional Jira project, SLA
policy, and role-based team membership.

```
Scan / Report  →  Findings  →  Triage  →  Tickets  →  Jira sync  →  Fix branch + PR  →  Manual review + merge
```

---

## Core Capabilities

### 1. Vulnerability Intake
- **CSV ingestion** from arbitrary scanner exports — column-name aliasing normalizes
  differing vendor schemas (severity, CVSS, CWE, component, CVEs, affected/fixed
  versions, etc.) into one canonical finding shape.
- **Bankai-owned repository scanning** — pinned repository revisions are analyzed with
  Trivy, Semgrep, Gitleaks, OSV Scanner, and applicable Bandit, `npm audit`, and `pip-audit` runs.
  Scanner output is normalized into Bankai findings with provenance.
- **Jira import** — existing Jira issues can be pulled in as findings, keeping legacy
  backlogs inside the same triage and remediation flow.
- **Automatic repository scans** — connecting GitHub queues the first scan at a pinned
  commit. HMAC-verified webhooks queue deduplicated scans for default-branch pushes and
  pull request revisions. PR results stay separate from baseline findings and tickets.
- **Pull request verification** — project Settings lets teams select Jenkins, reviewed
  GitHub Actions setup, or no CI. Bankai observes the chosen provider and reports exact
  commit state; an unconfigured or pending integration is never reported as passing.
- **Jira Cloud authorization** — Atlassian OAuth discovers available sites and projects;
  the existing API-token connection remains available as a fallback.

### 2. Triage & Deduplication
Every finding is fingerprinted so repeat scans classify into **New Delta / In Progress /
Changed / Resolved** buckets instead of re-flagging the same issue every run. Each project
defines its own SLA policy (days-to-remediate per severity — Critical/High/Medium/Low),
and every finding/ticket carries a computed **Missed / Approaching / On track** status.

### 3. Ticketing & Jira Sync
Findings are promoted into tickets with a project-scoped, sequential key
(`<prefix>-<n>`). Tickets can be pushed to a connected Jira project as real issues and
kept in sync bidirectionally — status transitions (`To Do → In Progress → In Review →
Done`) mirror ticket and pull request state, and Bankai posts remediation updates as Jira comments.

### 4. AI-Assisted Automated Remediation
For a ticket with a connected GitHub repo, Bankai:
1. Creates a dedicated remediation branch and gathers targeted repo context (surrounding
   source, related tests, directory tree) bounded by configurable budgets.
2. Calls **DeepSeek** to generate a concrete code fix for the finding.
3. Commits the fix to the branch and opens a **pull request**, transitioning the linked
   Jira issue and recording the action in the project activity feed.
4. Hands the pull request to the user for review; Bankai records whether it is open, closed,
   or merged, and never merges it automatically.

### 5. Manual pull request review
Bankai leaves build, test, and merge decisions to the repository's normal review process.
Ticket completion is recorded after the remediation pull request is merged.

### 6. Collaboration & Access Control
Projects support multi-user membership with four roles — **Owner, Admin, Editor,
Viewer** — enforced by both Postgres row-level security and an explicit
`requireRole` check in every controller (so a blocked write surfaces as a loud 403, not a
silent no-op). Teammates are added via email invite with accept/decline flows.

### 7. Activity & Audit Trail
Every meaningful state change — scan completed, finding triaged, ticket created, PR
opened or merged, member added — is recorded as a structured, project-scoped
activity event for full auditability.

---

## Architecture

```mermaid
flowchart LR
    subgraph Client
        FE["React SPA<br/>(Vite + TypeScript)"]
    end

    subgraph Edge
        NGINX["nginx<br/>static bundle + /api reverse proxy"]
    end

    subgraph API["Backend API (Express)"]
        AUTH["Auth / Session"]
        PROJ["Projects / Findings / Tickets"]
        WEBHOOK["Webhooks<br/>(GitHub push and pull request)"]
    end

    subgraph Async["Background Workers (BullMQ)"]
        SCAN["repo-scan"]
        FIXPR["fix-pr"]
    end

    REDIS[("Redis")]
    DB[("Supabase Postgres<br/>+ Row-Level Security")]
    SUPAAUTH["Supabase Auth"]

    GH["GitHub API"]
    JIRA["Jira Cloud API"]
    GEMINI["DeepSeek via OpenRouter"]
    ARCJET["Arcjet<br/>WAF / bot / rate limit"]

    FE -->|HTTPS| NGINX --> API
    API --> SUPAAUTH
    API --> DB
    API -->|enqueue| REDIS
    REDIS --> Async
    Async --> DB
    Async --> GH
    Async --> JIRA
    Async --> GEMINI
    GH -->|webhooks| WEBHOOK
    API --> ARCJET
```

- **Frontend** — a single-page app (workspace shell + sidebar routing) for auth, project
  management, and the full remediation workflow: Overview, Report Intake, AI Triage,
  Tickets, Activity, and Settings.
- **Backend API** — stateless Express process; every state-changing route is
  project-scoped, role-checked, and Arcjet-protected.
- **Worker** — a separate Node process consuming the repository-scan and remediation-PR
  queues backed by Redis.
- **Supabase** — Postgres (with RLS as the primary authorization boundary) and Auth
  (email/password + Google/GitHub OAuth).
- **External integrations** — GitHub (repo scanning, branch/commit/PR, webhooks),
  Jira Cloud (issue sync, comments, transitions), DeepSeek via OpenRouter (finding generation and
  fix generation), Arcjet (WAF, bot detection, rate limiting).

---

## Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, React Router 7, Oxlint |
| Backend API | Node.js 22, Express 5, TypeScript, Zod |
| Background jobs | BullMQ (Redis-backed) |
| Database & Auth | Supabase (Postgres + Row-Level Security, Supabase Auth) |
| AI | Configured OpenRouter/Gemini provider for triage and patch generation |
| Security | Arcjet (WAF, bot detection, rate limiting, email validation), helmet, httpOnly cookie sessions |
| Integrations | GitHub REST API, Jira Cloud REST API |
| Observability | Pino (structured logging), pino-http |
| Testing | Vitest |
| Containerization | Docker, multi-stage builds, nginx (frontend/edge), Docker Compose |
| CI | GitHub Actions |

---

## Repository Structure

```
.
├── frontend/                    React + Vite + TypeScript SPA
│   └── src/
│       ├── pages/                Auth pages, Projects, workspace shell
│       │   └── workspace-pages/  Overview, Report Intake, AI Triage, Tickets, Activity, Settings
│       ├── components/           Sidebar, RepoPicker, InviteBell
│       └── lib/                  API client, auth context, project context, roles
│
├── backend/                     Express + TypeScript API and worker
│   └── src/
│       ├── controllers/          Request handlers (auth, projects, findings, tickets, github, jira, sso, webhooks, ...)
│       ├── routes/               Route definitions, project-scoped nesting
│       ├── middleware/           requireAuth, loadProject, origin-check, Arcjet baseline
│       ├── schemas/               Zod request validation
│       ├── jobs/                  BullMQ processors (repo-scan, fix-pr)
│       ├── lib/                   GitHub/Jira/AI clients, crypto, scanner and repo context,
│       │                          stack detection, log parsing, SLA logic, repo context assembly
│       ├── server.ts              API entrypoint
│       └── worker.ts              Background worker entrypoint
│
├── supabase/
│   └── migrations/               Ordered SQL migrations (schema + RLS policies)
│
├── deploy/
│   ├── Dockerfile                 Multi-stage build → static bundle served by nginx
│   └── nginx.conf                 SPA routing + reverse proxy of /api to the backend
│
├── docker-compose.yml             Local, production-like run (frontend :8080, backend behind it)
├── .github/workflows/deploy.yml   CI: frontend build, backend typecheck + build
└── .env.example                   Frontend env template
```

---

## Getting Started

### Prerequisites

- Node.js **≥ 22.21**
- Two [Supabase](https://supabase.com) projects: one for development and one for production
- A [Redis](https://redis.io) instance (local Docker/native install is fine for dev)
- An [Arcjet](https://app.arcjet.com) site key
- A [DeepSeek via OpenRouter](https://openrouter.ai/settings/keys) API key
- A GitHub OAuth App (for "Connect your GitHub account")

### Backend

```bash
cd backend
npm install
cp .env.example .env      # fill in the development Supabase project, Arcjet, DeepSeek, GitHub OAuth, Redis
npm run dev                # API on http://localhost:4000
```

Run the background worker in a separate terminal (required for scans, AI fixes, and CI
dispatch to actually process):

```bash
cd backend
npm run worker
```

### Frontend

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173
```

### Database

Use separate Supabase projects for development and production. They should have
the same schema, but separate data, users, Auth providers, redirect URLs, and
service-role keys.

1. Create a development Supabase project and a production Supabase project.
2. Apply the migrations in `supabase/migrations/` to both projects, in filename order.
3. Put only development Supabase credentials in `backend/.env`:
   `APP_ENV=development` and `SUPABASE_ENV=development`.
4. Put only production Supabase credentials in your deployment environment:
   `APP_ENV=production` and `SUPABASE_ENV=production`.

The backend validates this at startup and refuses to run if `APP_ENV` and
`SUPABASE_ENV` do not match. It also refuses `NODE_ENV=production` unless
`APP_ENV=production`.

### Tests & Checks

```bash
cd backend
npm run typecheck
npm run lint
npm test

cd ../frontend
npm run lint
npm run build
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
| --- | --- | --- |
| `NODE_ENV` | no | `development` \| `production` \| `test` |
| `APP_ENV` | no | Runtime environment label, `development` or `production`; must be `production` when `NODE_ENV=production` |
| `PORT` | no | API port (default `4000`) |
| `SUPABASE_ENV` | no | Supabase project label, `development` or `production`; must match `APP_ENV` |
| `SUPABASE_URL` | yes | Supabase project URL for the matching environment |
| `SUPABASE_ANON_KEY` | yes | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role key — **backend only, never exposed to the frontend** |
| `ARCJET_KEY` | yes | Arcjet site key |
| `TOKEN_ENC_KEY` | yes | Base64 of 32 random bytes; encrypts Jira tokens, GitHub PATs/webhook secrets at rest |
| `FRONTEND_ORIGIN` | yes | Exact frontend origin — used for CORS, CSRF origin checks, and email redirect links |
| `COOKIE_DOMAIN` | no | Shared registrable domain for session cookies in production |
| `COOKIE_SAMESITE` | no | `lax` (default) \| `strict` \| `none` |
| `OPENROUTER_API_KEY` | yes | OpenRouter key for Bankai triage and patch generation |
| `OPENROUTER_MODEL_NAME` | no | OpenRouter model used by Bankai |
| `AI_PROVIDER` | no | `openrouter` (default), or `gemini` for legacy compatibility |
| `REDIS_URL` | no | Defaults to `redis://localhost:6379` |
| `BACKEND_PUBLIC_URL` | no | Publicly reachable backend URL, used to auto-register GitHub push webhooks |
| `MAX_SCAN_FILES` / `MAX_SCAN_FILE_BYTES` / `MAX_SCAN_TOTAL_BYTES` | no | Bound repo-scan volume/latency |
| `MAX_FIX_CONTEXT_FILES` / `MAX_FIX_CONTEXT_BYTES` / `MAX_FIX_TEST_FILES` / `MAX_FIX_TREE_DEPTH` | no | Bound AI fix-generation context assembly |
| `GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` | yes | GitHub OAuth App for per-user "Connect your GitHub account" |
| `ATLASSIAN_OAUTH_CLIENT_ID` / `ATLASSIAN_OAUTH_CLIENT_SECRET` | no | Optional Atlassian 3LO app for one-click Jira Cloud authorization |
| `ATLASSIAN_OAUTH_REDIRECT_URI` | no | Optional Jira callback override; defaults to `{BACKEND_PUBLIC_URL}/api/jira/oauth/callback` |

For Jira OAuth, register the callback URL shown in `backend/.env.example` in the Atlassian
developer console. Apply pending Supabase migrations before deploying the repository
automation, Jira OAuth, and hosted CI changes.

Full definitions and defaults live in [`backend/src/env.ts`](backend/src/env.ts) and are
validated (fail-fast) at process startup.

> "Log in with Google/GitHub" SSO uses Supabase's own OAuth provider configuration
> (dashboard-side) and needs no additional backend env vars — see
> [`backend/.env.example`](backend/.env.example) for the one-time setup steps.

### Frontend (`frontend/.env`)

| Variable | Description |
| --- | --- |
| `VITE_API_BASE_URL` | Backend base URL for local dev (e.g. `http://localhost:4000`). Left empty in production builds — nginx reverse-proxies `/api` to the backend. |

---

## Data Model

Schema evolves through ordered migrations in `supabase/migrations/`. Principal tables:

| Table | Purpose |
| --- | --- |
| `profiles` | User profile, including linked GitHub OAuth identity |
| `projects` | One per managed application/repo — SLA policy, GitHub/Jira connection state, ticket key sequence |
| `project_services` | Services/components tracked under a project |
| `project_members` / `project_invites` | Role-based membership and pending email invites |
| `scans` | A single ingestion run (CSV upload or AI repo scan), with status, commit range, and trigger type |
| `findings` | Normalized vulnerability records — severity, CVSS, CWE, CVEs, affected/fixed versions, remediation guidance, source (csv / github_ai / jira_import) |
| `tickets` | Promoted, trackable units of work — Jira linkage, GitHub branch/PR tracking, CI status/run URL, fix-attempt counter |
| `pipeline_runs` | Retained historical CI dispatch records |
| `activity_events` | Append-only, project-scoped audit log |

All tables enforce **row-level security** scoped to project ownership/membership;
role-gated mutations (insert/update/delete) are further restricted to Editor and above.

---

## API Surface

All routes are mounted under `/api`. Project-scoped routes require an authenticated
session and project membership; `loadProject` resolves and authorizes the project once
per request before any nested route runs.

| Base path | Covers |
| --- | --- |
| `/api/auth` | Sign up, login, logout, refresh, session, profile, password, account deletion |
| `/api/auth/github` | Per-user GitHub OAuth connect/disconnect/status/repo listing |
| `/api/auth/sso` | "Log in with Google/GitHub" via Supabase OAuth |
| `/api/projects` | Create/list/get/delete projects |
| `/api/projects/:id` | Update project settings |
| `/api/projects/:id/scans` | List scans, upload CSV, trigger/inspect scans |
| `/api/projects/:id/findings` | List/update findings |
| `/api/projects/:id/tickets` | List/create tickets and sync to Jira |
| `/api/projects/:id/jira` | Connect/disconnect Jira |
| `/api/projects/:id/github` | Connect/disconnect repo, trigger AI scan |
| `/api/projects/:id/sla` | Update SLA policy |
| `/api/projects/:id/members` | Manage members and invites |
| `/api/projects/:id/overview` | Aggregate project stats |
| `/api/projects/:id/activity` | Project audit log |
| `/api/invites` | Accept/decline invites by token |
| `/api/webhooks/github/:projectId` | GitHub push and pull request webhooks (HMAC-verified) |

---

## Security Architecture

- **Session model**: httpOnly, `SameSite` access/refresh cookies (`bankai_at` /
  `bankai_rt`) — never `localStorage` or a JSON response body — so sessions aren't
  reachable via XSS.
- **Arcjet**: Shield WAF, bot detection, and IP-based sliding-window rate limiting on
  authentication and other sensitive endpoints; disposable/invalid/undeliverable email
  rejection on signup.
- **CSRF defense-in-depth**: an explicit `Origin` header check on state-changing
  requests, layered on top of `SameSite` cookies.
- **Enumeration resistance**: signup returns an identical response regardless of whether
  the email is already registered.
- **Secrets at rest**: Jira API tokens, GitHub PATs, and GitHub webhook secrets are
  encrypted (`TOKEN_ENC_KEY`) before being persisted.
- **Webhook integrity**: GitHub webhook payloads are verified via HMAC signature against
  the raw request body (mounted ahead of the JSON body parser specifically to preserve
  those bytes).
- **Authorization defense-in-depth**: Postgres row-level security is the primary boundary;
  every controller additionally enforces role checks explicitly, so a disallowed write
  fails loudly (`403`) rather than silently affecting zero rows.
- **Server-side session revocation**: logout revokes the refresh token via the Supabase
  admin API (`signOut(token, "global")`), not just a client-side cookie clear.
- **Standard hardening**: `helmet` security headers, strict CORS bound to
  `FRONTEND_ORIGIN` with credentials, app-level password policy stricter than Supabase's
  default.

---

## Build and deployment checks

This repository's own workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
checks Bankai source changes. Bankai Desktop can observe local Jenkins multibranch PR jobs
for remediation pull requests. Jenkins starts the automatic PR build; Bankai reconciles the
exact commit and does not start another build when discovery is delayed. Developers review
and merge remediation pull requests themselves.

---

## Deployment

### Docker Compose (production-like, local)

```bash
APP_ENV=production SUPABASE_ENV=production SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... ARCJET_KEY=... \
  docker compose up --build
# Frontend (and /api, reverse-proxied to the backend) at http://localhost:8080
```

`docker-compose.yml` runs two services: `backend` (built from `backend/Dockerfile`, a
multi-stage Node 22 Alpine build running as a non-root user) and `frontend` (built from
`deploy/Dockerfile`, a static bundle served by nginx per `deploy/nginx.conf`, which also
reverse-proxies `/api` to the backend and handles SPA routing).

### Manual build

```bash
cd frontend && npm install && npm run build   # → frontend/dist
cd ../backend && npm install && npm run build # → backend/dist
```

The background worker (`backend/src/worker.ts`) must be deployed as its own process
alongside the API server — it is not started automatically by `npm start`.

---

## Project Status

Actively developed. Implemented: authentication (including SSO and forgot/reset password),
project and team management, CSV and Bankai-owned repository scanning, finding triage with
SLA tracking, Jira ticket sync, AI-generated remediation branches and pull requests, and
manual review and merge tracking.

Known limitation: Arcjet's local fingerprint generator (`@arcjet/node@1.9.1`) currently
prevents rate-limiting `/login` by submitted email in addition to IP — see
[`backend/README.md`](backend/README.md#known-issue-arcjet-custom-characteristics) for
details and revisit criteria.

---

## License

Bankai is open source, licensed under the [MIT License](LICENSE).
