# Bankai Scan Fixtures

A deliberately vulnerable, synthetic application repository for exercising Bankai repository scanning and remediation workflows. All data and credentials are fake. The examples are intentionally unsafe and are for isolated local testing only; do not deploy this app or reuse its patterns in production.

## Scan with Bankai

1. Put this repository in a Git remote that Bankai can access (for example, create a private GitHub repository and push this folder).
2. In Bankai, connect that repository and start a repository scan.
3. Findings should point to the intentionally vulnerable examples below. Scanner coverage comes from Bankai's pinned Trivy, Semgrep, Gitleaks, OSV, and applicable ecosystem scanners.

This repository includes no real secrets, external-service credentials, malware, or destructive payloads. The SQL and command examples are inert unless the corresponding functions are called by an application.

## Fixture inventory

| File | Intended issue | Common rule family |
| --- | --- | --- |
| `src/auth.py` | SQL query built with string interpolation; weak password comparison; predictable signing key | SQL injection, weak crypto/secret |
| `src/commands.py` | Shell command built from caller-controlled text | OS command injection |
| `src/files.py` | Untrusted path joined to a storage directory without containment checks | Path traversal |
| `src/config.py` | Debug mode and fake development credentials in source | Debug configuration, hardcoded credential |
| `src/web.py` | Permissive CORS and overly detailed error responses | CORS, information disclosure |
| `requirements.txt` | Old intentionally vulnerable dependency versions | Vulnerable dependencies (SCA) |

## Local checks

The Python files are syntax-checkable with Python 3.10+. No service is started by these fixtures. The tests only inspect safe, inert source behavior and do not execute shell commands or exploit the intentionally vulnerable functions.

```bash
python -m pytest
```

To initialize a local Git repository and push it to a remote you control:

```bash
git init
git add .
git commit -m "Add Bankai scan fixtures"
git branch -M main
git remote add origin <your-private-repository-url>
git push -u origin main
```

Use a separate branch or clone for remediation experiments. The base branch intentionally retains the vulnerable patterns so repeated scans have a stable baseline.
