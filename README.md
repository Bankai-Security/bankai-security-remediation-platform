# Bankai — Vulnerability Remediation Platform

A security tool that ingests raw vulnerability scan output and drives it through an automated triage-to-ticketing pipeline.

## Structure

```
.
├── frontend/           React + Vite + TypeScript app
├── deploy/
│   ├── Dockerfile      Multi-stage build → static bundle served by nginx
│   └── nginx.conf      SPA routing (falls back to index.html)
├── docker-compose.yml  Local prod-like run (frontend on :8080)
├── .github/workflows/  CI build placeholder
└── .env.example        Copy to frontend/.env once a backend exists
```

## Local development

```bash
cd frontend
npm install
npm run dev
```

## Production build

```bash
cd frontend
npm install
npm run build   # outputs frontend/dist
```

## Run via Docker

```bash
docker compose up --build
# serves the built frontend at http://localhost:8080
```

## Status

The frontend currently implements: Login, Sign Up, Projects, New Project (full), and a
persistent Workspace shell (sidebar + routing) with placeholder pages for Remediation
Workflow, Overview, Report Intake, AI Triage, Tickets, Activity, and Settings. No backend
exists yet — all data is local component state.
