// Existing optional GitHub Actions verification workflow. Bankai may dispatch
// it when a repository owner has configured it; Bankai never creates it.
export const CI_WORKFLOW_FILE = "bankai-verify.yml";
export const CI_WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW_FILE}`;

// Marker used by the webhook verdict parser to reject workflows that still
// contain unconfigured placeholder checks.
export const PLACEHOLDER_MARKER = "TODO - add this repo's";
