# PRODUCT.md — Bankai

## What it is

**Bankai** is a security remediation platform that closes the loop between vulnerability
discovery and verified fixes. Scanners already find the problems — Bankai owns everything
*after* the scan:

```
Scan / Report → Findings → Triage → Tickets → Jira sync → AI Fix PR → CI Verification
```

- Ingests raw scanner output (CSV from any vendor, AI repo scans, Jira imports)
- Deduplicates and fingerprints findings across repeat scans (New / Changed / Resolved deltas)
- Tracks SLA per severity (Missed / Approaching / On track)
- Promotes findings into tickets, syncs bidirectionally with Jira
- Generates AI-authored code fixes, commits them to a branch, opens a real pull request
- Verifies every fix through a CI pipeline it bootstraps into the customer's repo
  (build → image → deploy-dev → functional-test → integration-test)
- On CI failure: parses the logs, regenerates the fix, retries — bounded — before a human sees it

The name is a Bleach reference: *bankai* is the final, fully-released form of a weapon.
The product ethos matches — not another scanner (a *shikai* at best), but the released
state: findings become merged, CI-verified pull requests.

## Who it's for

- **Security engineers** drowning in scanner output who need CVE spreadsheets turned into
  tracked, deduplicated, SLA-bound work.
- **Engineering leads / platform teams** who want remediation to flow through the tools
  they already trust: GitHub PRs, Jira tickets, CI gates.
- **Small-to-mid teams without a dedicated AppSec function** who need the loop automated
  end-to-end, with role-based access (Owner/Admin/Editor/Viewer) and a full audit trail.

Audience is technical. They read CI logs. They distrust "AI magic" claims and respect
evidence: a PR diff, a green pipeline, an audit event.

## Tone

**Confident and direct, not startup-bro.** The voice of an engineer who has been on-call.

- Declarative sentences. Concrete nouns: findings, tickets, PRs, pipelines — not "insights,"
  "synergy," or "supercharge."
- The AI is a worker, not a wizard. Lead with verification, not generation:
  "Bankai does not trust its own fixes blindly" is the brand's strongest sentence.
- Dry precision over hype. Numbers, states, and pipeline stages are the vocabulary.
- The Bleach undertone stays subtextual — sharpness, release, the slash mark — never
  anime cosplay. No katanas, no Japanese text pasted on for flavor.

## Anti-references (what this must NOT look like)

- **Generic SaaS gradient-land**: purple-to-blue mesh gradients, glassmorphism cards,
  floating 3D blobs, gradient text headlines.
- **Dark-dashboard clichés**: neon green "matrix" hacker aesthetic, scanline overlays,
  skull iconography, "military-grade" fear language.
- **Template landing pages**: three identical feature cards in a row, stock testimonial
  carousels, side-stripe borders on cards, wall-of-logos with fake companies.
- **AI-tool hype pages**: sparkle emoji, "10x your workflow," chat-bubble mockups,
  typewriter-effect headlines.

If the design could be predicted from "dark-mode security SaaS" alone, it fails.

## Register

**Brand.** This is a marketing page — the design *is* the product's first proof of
craft. A platform that promises CI-verified precision must itself look precise:
terminal-honest typography, real pipeline states, ASCII structure used as a design
material (the audience lives in monospace), and the slash mark used with restraint.

## Existing brand assets & design language

- `frontend/src/assets/bankai-mark.svg` — angular black slash/swoosh mark
- `frontend/src/assets/bankai-wordmark.svg` — custom italic angular wordmark (all caps,
  speed-slanted letterforms)
- Product app palette (light): bg `#F4F4F5`, text `#1C1C1E`, accent blue `#2563EB`,
  success green `#22C55E`, danger red `#DC2626`; radius 10–20px; pill CTAs
- The landing page is **dark-themed** — it inverts the app's neutral discipline rather
  than importing a new palette family: near-black surfaces, high-contrast off-white type,
  the same blue/green/red used strictly as state colors (CI pass/fail, severity), not decoration.
- Severity colors (Critical/High/Medium/Low) and CI states (pass/fail/running) are the
  only permitted color moments.

## Page context

This landing page is the pre-login root (`/`) of the existing Vite + React SPA. Primary
CTA: Sign up. Secondary: Log in. Everything a visitor sees before authenticating.
