# Bankai local Jenkins companion

This guide uses the intended split setup: **Bankai runs in Railway staging; Quincy, Jenkins, and the companion run on your Windows computer.** The companion makes outbound HTTPS requests to Bankai and loopback requests to local Quincy/Jenkins. It submits one explicitly selected remediation attempt and uploads Quincy's manifest and evidence artifacts to Bankai. It is a developer workflow, not a trusted CI service.

## What a successful run means

- Bankai records the result as a **local pass** after checking the attempt and candidate SHA, Quincy manifest, uploaded artifact hashes, evidence completeness, and target comparison.
- A local pass does **not** set a remediation to `VERIFIED`, publish a successful GitHub status, or satisfy required branch protection. Local machines are not trusted provenance.
- The companion source is unsigned. Use only repositories and code you are authorized to run. The current Jenkins verification profile fetches the repository without a GitHub credential, so use a public repository. Do not expose Jenkins, Quincy, or the runner to the internet.

## Prerequisites

- Windows 10/11, Node.js 20+, Git, Docker Desktop, Python 3.12, and OpenSSL.
- Bankai repository and the adjacent `quincy-security-engine` checkout.
- A Bankai Railway staging backend/database with all required migrations applied and `LOCAL_RUNNER_ENABLED=true` on the staging backend.
- A Quincy virtual environment with its development dependencies installed.
- A current Bankai remediation attempt with a generated patch and candidate SHA.

Use Railway's **staging** environment and its intended staging Supabase project. Confirm that database target and migration history before applying changes; never point this workflow at production. The runner feature flag defaults to disabled and must be enabled on staging after the migrations are present. This guide does not require a local Bankai API, frontend, or Redis.

## 1. Prepare Bankai staging

In Railway, select the **staging** environment and `bankai-backend`. Confirm `SUPABASE_ENV=development` (the backend enforces that `APP_ENV` and `SUPABASE_ENV` match) and inspect `SUPABASE_URL` in the Variables page. Copy only the project ref from its hostname; never share the URL if it contains extra credentials, and never copy Supabase keys into chat. Confirm in Supabase that this is the intended non-production database.

From the Bankai repository root, link Supabase CLI to that verified ref and compare local and remote histories:

```powershell
supabase link --project-ref <verified-staging-project-ref>
supabase migration list --linked
```

Apply only after confirming the linked ref is the Railway staging database:

```powershell
supabase db push --linked
```

The runner control plane, lease recovery, result guard, dispatch, and readiness migrations must all be present; the dispatch migration alone is not sufficient. The linked CLI target is independent of Railway's `SUPABASE_URL` variable, so verify both refer to the same project before pushing.

In Railway staging's `bankai-backend` Variables, set:

```dotenv
LOCAL_RUNNER_ENABLED=true
```

Redeploy/restart the staging backend after migrations and this variable are ready. This flag enables dispatch only; it does not make the machine or result trusted. Keep the staging backend's existing `QUINCY_API_URL` and `QUINCY_API_TOKEN` for Bankai's regular hosted Quincy integration; they are not the credentials the local companion uses for its local Quincy service.

## 2. Prepare Quincy and its isolated Jenkins

In the Quincy checkout, create/activate its documented virtual environment and install the project dependencies (`pip install -e ".[dev]"`). Start the local Jenkins stack from that checkout:

```powershell
cd C:\path\to\quincy-security-engine
.\tools\local-jenkins\start.ps1
```

The script creates local credentials and a local CA under `tools/local-jenkins/.local`, starts the pinned Jenkins/agent images, and checks that the `quincy-verification` job and agent are ready. Keep this terminal open. Do not replace the pinned image with an unreviewed/latest image. The Jenkins HTTPS endpoint is `https://localhost:8443`; its CA certificate is `tools/local-jenkins/.local/certs/jenkins.crt`.

Configure Quincy's local environment (use its ignored `.env`, shell environment, or local settings mechanism) with these values. Read the Jenkins API token from `tools/local-jenkins/.local/secrets/jenkins-api-token`; set an expiry sufficiently far in the future for the configured verification timeout plus grace period. Generate a separate local `SERVICE_API_TOKEN` for this Quincy instance. The companion will use it to call local Quincy; it does not need to match Railway's Quincy service token.

```dotenv
SERVICE_API_TOKEN=<local-only shared secret>
JENKINS_BASE_URL=https://localhost:8443
JENKINS_JOB_NAME=quincy-verification
JENKINS_USERNAME=quincy-test
JENKINS_TOKEN=<value from local-jenkins/.local/secrets/jenkins-api-token>
JENKINS_TOKEN_EXPIRES_AT=<ISO-8601 timestamp with timezone>
JENKINS_CA_BUNDLE=<absolute path to local-jenkins/.local/certs/jenkins.crt>
ENABLED_SCANNERS=["schrift"]
VERIFICATION_ALLOWED_REPOSITORIES=["github_url:https://github.com/OWNER/REPO"]
```

Replace the allowlist with the exact public GitHub repository URL and owner/name in the remediation. Do not use a wildcard allowlist.

Start the Quincy API in another Quincy PowerShell window, from its repository root with the virtual environment active:

```powershell
uvicorn quincy.api.app:create_app --factory --host 127.0.0.1 --port 8000
```

Check `http://127.0.0.1:8000/health` and `https://localhost:8443/login` locally. Quincy should use the `jenkins-schrift-comparison-v1` verification profile. Keep both services bound to loopback. If your checkout uses its provided launcher instead, verify that it still binds the API to `127.0.0.1:8000` and loads the settings above.

## 3. Open Bankai staging

Open the Railway staging Bankai frontend, sign in, select the project, and go to **Jenkins Verification** (workspace route `local-verification`). Confirm the page says runner dispatch is enabled and that the remediation attempt you expect to verify is listed. Generate a one-time pairing code from that page. If dispatch is disabled or the page cannot load the migration-backed data, stop and fix the staging migrations/feature flag first.

## 4. Pair the companion

In a PowerShell window on the machine running Jenkins, set the endpoints and one-time values. `BANKAI_API_URL` must be the Railway staging **backend** origin (not the frontend URL). Quincy remains loopback on your computer.

```powershell
cd C:\path\to\bankai-security-remediation-platform
$env:BANKAI_API_URL = 'https://bankai-backend-staging.up.railway.app'
$env:QUINCY_API_URL = 'http://127.0.0.1:8000'
$env:BANKAI_PAIRING_CODE = '<one-time code from Bankai>'
$env:QUINCY_API_TOKEN = '<local Quincy SERVICE_API_TOKEN>'
$env:QUINCY_JENKINS_CA = 'C:\path\to\quincy-security-engine\tools\local-jenkins\.local\certs\jenkins.crt'
node .\tools\local-runner\runner.mjs pair
```

The code is single use and expires after 10 minutes. Pairing stores the Bankai and Quincy credentials in Windows Credential Manager. The config under `%LOCALAPPDATA%\BankaiLocalRunner` stores endpoint URLs and credential target names, not bearer-token values. After pairing, clear the temporary secret environment variables in that window:

```powershell
Remove-Item Env:BANKAI_PAIRING_CODE, Env:QUINCY_API_TOKEN
```

## 5. Run a selected remediation

Start the companion in that same PowerShell window:

```powershell
node .\tools\local-runner\runner.mjs
```

It checks local Docker/Jenkins/Quincy readiness, polls the Railway staging backend only for work assigned to the paired project, claims a task, forwards progress and cancellation, and submits the finalized result and artifacts to Bankai. Leave it running while the job executes. In Bankai staging's **Jenkins Verification** page, choose **Run with Jenkins** for the specific current remediation attempt. **Skip Jenkins** records the choice and does not queue work.

Do not submit a different commit or edit the candidate while that attempt is running. Check the task history and artifact links in Bankai after the companion reports completion.

## 6. Read the result

- **Local pass:** Quincy and evidence validation passed for the exact attempt/SHA. This is useful developer evidence, but remediation remains unverified and GitHub status does not become a success.
- **Failure or incomplete:** inspect the task detail/history and download the available manifest, build log, test report, and scanner report. Resolve the issue, generate a new remediation attempt if the candidate changes, and explicitly run that attempt.
- **Waiting for runner / readiness:** the companion has not claimed work yet. Check that the companion is running and Docker, Jenkins, Quincy API, and the certificate are ready.

The GitHub context `Bankai / Local Jenkins Verification` intentionally cannot report a successful status from a local pass. Production-grade verification still requires trusted hosted provenance, the reviewed GitHub Check Runs integration, and a signed/approved companion distribution.

## 7. Stop services and revoke access

Press Ctrl+C in the companion, Quincy API, and any foreground Bankai processes. Stop Jenkins using the Quincy checkout's `tools/local-jenkins/stop.ps1`. Stop any Redis container started solely for this session using the command shown by your local launcher. In Bankai's runner list, revoke the paired runner when finished. Clear temporary shell variables or close that PowerShell window. Remove local Jenkins secrets/certificates only after Jenkins is stopped and you no longer need that local environment; the `.local` directory contains credentials and must not be committed.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Dispatch disabled in Bankai | `LOCAL_RUNNER_ENABLED=true` is in Railway staging's `bankai-backend` environment, all required migrations are on the Supabase project referenced by staging, and the backend was redeployed. |
| No task appears | Select the right project; confirm a current remediation attempt with a candidate SHA exists; choose **Run with Jenkins**; keep the companion paired to that project. |
| Pair code rejected | Generate a fresh code and pair within 10 minutes. A code can only be used once. |
| Companion waits for readiness | Check Docker Desktop, `http://127.0.0.1:8000/health`, Jenkins at `https://localhost:8443/login`, and the absolute `QUINCY_JENKINS_CA` path. |
| Quincy rejects repository | Add the exact `github_url:https://github.com/OWNER/REPO` to the Quincy verification allowlist and restart Quincy. The current flow is for public repositories. |
| Quincy cannot submit to Jenkins | Recheck the local job name, `quincy-test` user, token value and expiry, CA bundle, and that `quincy-verification` has a connected agent. |
| Local pass but GitHub remains pending | Expected: local passes never publish trusted success or mark the remediation `VERIFIED`. |

For security boundary details and Quincy Jenkins isolation behavior, consult the Quincy repository's `tools/local-jenkins` documentation. Treat this companion as a local developer tool until its source is signed and the trust model is reviewed.
