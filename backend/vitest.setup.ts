// env.ts validates process.env at import time and throws on failure — every
// required var needs a placeholder here before any test file (transitively)
// imports it, since vitest loads setupFiles first.
process.env.SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY ??= "test-anon-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
process.env.ARCJET_KEY ??= "test-arcjet-key";
process.env.TOKEN_ENC_KEY ??= "test-token-enc-key";
process.env.FRONTEND_ORIGIN ??= "http://localhost:5173";
process.env.GEMINI_API_KEY ??= "test-gemini-key";
process.env.GITHUB_OAUTH_CLIENT_ID ??= "test-github-client-id";
process.env.GITHUB_OAUTH_CLIENT_SECRET ??= "test-github-client-secret";
