# Bankai Desktop shell

This Electron shell hosts the existing Bankai web application and provides a separate, isolated browser window for a user's Jenkins site. It does not bundle or replace the Bankai backend. By default it loads the active Railway staging frontend at `https://bankai-frontend-staging.up.railway.app`. The frontend proxies `/api` to the Railway backend, so sign-in and OAuth use the same origins and configured callback routes as the web app.

## Development

1. From this directory, install the desktop dependencies: `npm install`.
2. Run `npm start` to open the Railway-hosted Bankai app inside the desktop shell.

To work against a local frontend, start Vite and run `npm run start:local`. Local frontend builds must set `VITE_API_BASE_URL` to the API they should use. OAuth will only succeed when the chosen backend/frontend callback origins are registered with Supabase and the OAuth providers; use `npm start` for the normal deployed OAuth flow.

## Packaging

The Bankai mark is maintained in `build/icon.svg`, with PNG/ICO/ICNS platform assets in the same folder. Install dependencies, then use `npm run package:win`, `npm run package:mac`, or `npm run package:linux` on the matching operating system. electron-builder writes installers under `release/bankai-desktop`.

Set `BANKAI_WEB_URL` at launch to select another Bankai frontend origin. Railway currently has the frontend and backend deployed in staging; its production environment has no services configured. The staging frontend routes `/api` to the backend over Railway's private network, so the desktop shell does not need Railway secrets or API keys. A production release still needs code signing/notarization, installer update strategy, and a published download URL; those release operations are not performed by this scaffold.

## Desktop behavior

- Authentication and the regular Bankai pages use the same web application and its existing session-cookie flow.
- Project deep links use `bankai://open?project=<project-id>` and open the Jenkins page for that project.
- Jenkins opens in a separate Electron window with its own persistent session partition, so Jenkins sign-in cookies remain separate from Bankai's.
- The renderer receives only a narrow context-isolated bridge. Jenkins addresses must use HTTPS, except localhost during local Jenkins use. Cross-origin navigation inside the Jenkins window is blocked.
- Jenkins credentials are entered on the desktop Jenkins page, checked against the Jenkins API, and encrypted with Electron's OS-backed `safeStorage` on this computer. Credentials are not sent to Bankai services.
- Bankai discovers Jenkins jobs, lets each repository select a build job, starts it with Jenkins' CSRF crumb when required, and reports its queued/running/result state with a link to the build in the Bankai browser.
- The per-project Jenkins preference is stored in the frontend's local storage. Choosing skip does not alter the existing scan, triage, remediation, or PR routes.

Build-to-PR evidence attachment, automated remediation retries, and deployment orchestration are later phases. The Windows/macOS/Linux package commands above create installers locally; a published desktop release is still required for the web download link to distribute an updated shell.
