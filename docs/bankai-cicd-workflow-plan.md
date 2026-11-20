# Bankai CI/CD Workflow Plan

## Purpose

Define a simple end-to-end workflow for scanning GitHub repositories, remediating assigned security findings, building and checking changes with Jenkins, and deploying successful builds.

## Product shape

- The web app remains the main Bankai experience for repository scanning, triage, remediation, and pull request review.
- When a user wants Jenkins functionality, the web app prompts them to download Bankai Desktop.
- Bankai Desktop provides the same Bankai experience, with a functional Jenkins page and a built-in browser for viewing Jenkins and deployment activity.
- Jenkins is optional. In the desktop app, users can opt in to connect Jenkins or opt out and continue using the rest of Bankai.

## End-to-end workflow

1. **Scan:** Bankai scans the connected repository.
2. **Triage:** Bankai groups and explains findings so the user can understand their severity and context.
3. **Assign:** The user assigns a finding or remediation ticket for work.
4. **Remediate:** Bankai proposes and implements a fix, then opens or updates a pull request for review.
5. **Build and check:** If Jenkins is enabled, Jenkins runs the repository pipeline against the proposed change. The build and configured security checks determine whether it passes.
6. **Deploy:** If CD is enabled and the configured deployment job is available, Bankai runs deployment after the required build and checks pass.
7. **Retry on failure:** If build, checks, or deployment fail, Bankai can use the failure details to propose a remediation and retry, subject to a retry limit. If it cannot pass, it returns the issue for human review.
8. **Attach evidence:** Once required stages succeed, Bankai attaches a concise summary and relevant evidence to the pull request.
9. **Review and merge:** The user reviews the code and evidence, then merges the pull request in GitHub.
10. **Repeat:** Bankai continues monitoring the repository and processes subsequent changes through the same workflow.

If Jenkins or CD is opted out or not configured, Bankai marks that stage as skipped/not configured. It must not present a skipped stage as a successful run.

## Jenkins setup in Bankai Desktop

The setup should be a short guided flow:

1. Ask the user for their Jenkins connection details and credentials.
2. Test the connection and report success or a clear fix for the connection problem.
3. Let the user choose or confirm the Jenkins job/pipeline for the repository.
4. Show build status, check results, logs, and links from the Jenkins page in Bankai Desktop.

Credentials should be stored securely on the user's device and never written into repository files or pull request evidence. The local app should clearly show when its Jenkins connection is unavailable and how to reconnect.

## Jenkinsfile handling

- Bankai checks whether the repository already contains a `Jenkinsfile`.
- If one exists, Bankai uses it as the pipeline definition and lets the user select the corresponding Jenkins job.
- If one does not exist, Bankai analyzes the repository's languages, build tools, tests, and existing CI configuration, then drafts a suitable `Jenkinsfile`.
- Bankai shows the proposed file to the user for review, with a plain-language summary of its stages. The user may approve it for a pull request, edit it, or skip Jenkins setup.
- The generated file is validated against detected project commands and should not assume deployment details or credentials.

## CD: keep the first version simple

For the first version, CD runs through the user's existing Jenkins deployment job. The deployment target is therefore the job that already knows where and how to deploy the project; the user does not need to configure a separate deployment provider in Bankai.

The user connects Jenkins, then selects or confirms the deployment job. Bankai runs it after the configured build and checks pass, displays whether deployment succeeded, and provides a link to Jenkins or the deployed environment when available. The built-in browser in Bankai Desktop lets the user inspect Jenkins and deployment activity.

If no deployment job exists, Bankai explains that CD is not configured and offers the user a way to select/configure a job. Bankai should not guess a destination or invent deployment credentials. Keep the initial setup focused on the Jenkins connection and job selection; broader provider integrations can come later.

## Evidence and failure behavior

Evidence attached to the pull request can include the commit/build identifier, pipeline result, configured check results, deployment result, timestamps, and links to relevant logs or deployment views. It must not include secrets.

Retries should be bounded. A failed run should preserve the failure details, show whether a retry is underway, and stop for human review after the retry limit or when the cause cannot be safely addressed by an automated code change.

## First-release scope

- Web app prompt that routes users to download Bankai Desktop for Jenkins functionality.
- Desktop opt-in/opt-out for Jenkins.
- Simple Jenkins credential and connection setup.
- Repository-aware Jenkinsfile proposal and user review when the file is missing.
- Build/check status in Bankai Desktop.
- CD through an existing Jenkins deployment job, with outcome visibility.
- Bounded remediation retries and pull request evidence.

## Later considerations

Direct deployment-provider integrations, more deployment targets, advanced environment policies, and broader production approval controls can be considered after the basic Jenkins-driven flow is working.
