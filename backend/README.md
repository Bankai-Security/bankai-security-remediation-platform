# Bankai backend

Express + TypeScript API providing sign up / sign in for the Bankai frontend, backed by
Supabase Auth and protected by [Arcjet](https://arcjet.com).

## Endpoints

All routes are mounted under `/api/auth`.

| Method | Path       | Auth required | Description |
| ------ | ---------- | -------------- | ----------- |
| POST   | `/signup`  | no  | Create an account. Always returns a generic "check your email" acknowledgement, even if the address is already registered, to avoid leaking which emails have accounts. |
| POST   | `/login`   | no  | Sign in with email + password. Sets `bankai_at` / `bankai_rt` httpOnly session cookies. |
| POST   | `/logout`  | no  | Revokes the current refresh token server-side and clears the session cookies. |
| POST   | `/refresh` | refresh cookie | Rotates the session using the refresh token cookie. |
| GET    | `/session` | access cookie  | Returns the current user, or 401. |

The session is stored as httpOnly, `SameSite` cookies — never in `localStorage` or a
response body — so it isn't reachable from JavaScript (XSS) and doesn't need manual
attachment on every request from the frontend (`fetch(..., { credentials: "include" })`
is enough).

## Security layers

- **Arcjet** (`src/lib/arcjet.ts`): Shield WAF, bot detection, and IP-based sliding-window
  rate limiting on `/signup` and `/login`; `/signup` additionally rejects disposable,
  syntactically invalid, and undeliverable (no MX record) email addresses via Arcjet's
  `protectSignup`.
- **Zod** (`src/schemas/auth.schema.ts`): request shape/type validation, plus an
  app-level password policy (10+ characters, upper/lower/digit) stricter than Supabase's
  default.
- **Origin check** (`src/middleware/origin-check.ts`): rejects state-changing requests
  whose `Origin` header doesn't match `FRONTEND_ORIGIN`, as defense-in-depth CSRF
  mitigation alongside `SameSite` cookies.
- **Supabase** enumeration resistance: signup returns the same response whether or not
  the email is already registered; Supabase itself hashes passwords and issues
  short-lived JWTs.
- **helmet** default security headers, and CORS locked to `FRONTEND_ORIGIN` with
  `credentials: true`.
- Server-side session revocation: `/logout` calls `auth.admin.signOut(token, "global")`
  with the service-role key so a leaked refresh token can't be replayed after logout,
  rather than just deleting the cookie client-side.

## Known issue: Arcjet custom characteristics

`@arcjet/node@1.9.1`'s local fingerprint generator errors out
(`"... characteristic but the ... value was empty"`) when a rule declares a
`characteristics` array other than the default `["ip.src"]` — reproduced with a minimal
script outside Express, with the value correctly present and passed through. Because of
this, `/login` currently only rate-limits by IP, not by the submitted email address (which
would additionally catch credential stuffing against one account spread across many
IPs). Revisit `src/lib/arcjet.ts` once this is fixed upstream, or if Arcjet ships a newer
SDK version.

## Setup

```bash
cd backend
npm install
cp .env.example .env   # fill in development Supabase + Arcjet credentials
npm run dev
```

Required environment variables are validated at startup — see `.env.example` for the
full list and `src/env.ts` for the schema. You'll need:

- Separate [Supabase](https://supabase.com) development and production projects
  (Project Settings → API for the URL, anon key, and service role key).
- An [Arcjet](https://app.arcjet.com) site key.

### Quincy Security Engine

Repo scans can optionally use the standalone Quincy Security Engine. Set
`QUINCY_API_URL` to the FastAPI service base URL, and set `QUINCY_API_TOKEN` when
Quincy is running with `SERVICE_API_TOKEN`. When configured, Bankai calls
`POST /triage/scan` first and falls back to the DeepSeek scan path if Quincy
is unavailable or cannot access the repository.

For local development, `backend/.env` should contain the development project's
credentials with `APP_ENV=development` and `SUPABASE_ENV=development`. Production
deployments should set production Supabase credentials with `APP_ENV=production`
and `SUPABASE_ENV=production`. The backend validates those labels at startup and
refuses to run when they do not match.

### Supabase auth settings

In the Supabase dashboard, under Authentication → Providers → Email:

- Decide whether "Confirm email" is enabled. If it is, `/signup` won't return a session
  immediately — the user must click the confirmation link before `/login` will succeed.
- Consider setting a minimum password length in line with (or below) this API's own
  policy of 10 characters, since Supabase re-validates on its end too.

## Scripts

- `npm run dev` — watch mode (`tsx watch`)
- `npm run build` — compile to `dist/`
- `npm start` — run the compiled build
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — `oxlint`

### DeepSeek configuration

Bankai defaults to `AI_PROVIDER=openrouter` and uses the same settings as Quincy:
`OPENROUTER_API_KEY`, `OPENROUTER_MODEL_NAME` (default
`deepseek/deepseek-v4-flash-0731`), and `OPENROUTER_BASE_URL` (default
`https://openrouter.ai/api/v1`). Put these in `backend/.env`; the Quincy launcher
reads them too. API keys stay on the backend. Gemini remains available with
`AI_PROVIDER=gemini` and `GEMINI_API_KEY`.

From the repository root, start the stack with:

```powershell
.\scripts\start-bankai-all.ps1 -NoNgrok
```

The default Quincy path is the sibling `quincy-security-engine` checkout. Override
it with `-QuincyPath`. Use `-QuincyDeepSeekModelName` to override the model for both
services. Docker must be running for Quincy's scanners and validation sandbox.
Service processes start in hidden windows; the API and worker must both restart
after changing AI settings.

Bankai submits scans to `/triage/scan`, starts remediation at
`/workflows/remediations`, and polls `/remediations/{job_id}/bankai`.
When Quincy is configured, remediation requires a Quincy-validated PR by default.
Failures stay visible on the ticket for retry. `QUINCY_ALLOW_FALLBACK=true`
explicitly permits Bankai's fallback PR generation without Quincy validation.
AI/CSV findings without a scanner rule ID pass their stored context to Quincy
using a stable Bankai finding identifier. CI retries use DeepSeek.
Truncated responses
are rejected and retried with a larger output budget. The provider request timeout
is controlled by `AI_REQUEST_TIMEOUT_MS` (default 120000).

`OPENROUTER_REASONING_ENABLED=false` reserves the model's completion budget for
the JSON artifact; it prevents DeepSeek from exhausting that budget before
returning a patch. Quincy's matching setting has the same default.

The API starts inline workers only with `BANKAI_INLINE_WORKER=true`. Normally,
run the dedicated worker or use the all-services launcher, which waits for
Quincy's health endpoint before starting the API and worker.

CI placeholders now produce `pending_setup`, not a passed verification. Replace
the commands on the remediation branch and retry CI. All five stages must be
present and pass. Workflow results from older branch commits cannot certify
newer code, and dispatch polling excludes runs that existed before the dispatch.
