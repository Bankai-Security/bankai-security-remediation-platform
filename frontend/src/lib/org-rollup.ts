import type { OrgProjectRef, ProjectStats } from './api';

export const EMPTY_STATS: ProjectStats = { totalCvits: 0, slaBreachedPct: 0, openTickets: 0 };

export interface Aggregate {
  totalCvits: number;
  openTickets: number;
  // Weighted by each project's CVIT count — a plain mean of percentages would
  // let a tiny project skew the org-wide number.
  slaBreachedPct: number;
  projectCount: number;
}

// Sums CVIT/ticket counts across a set of projects and computes a CVIT-weighted
// SLA-breach percentage. The input is whatever the RLS-scoped API returned, so
// a narrower (e.g. team-level) grant simply passes fewer projects in and gets a
// correspondingly smaller rollup — the aggregation itself is scope-agnostic.
export function aggregate(projects: { stats: ProjectStats }[]): Aggregate {
  const totalCvits = projects.reduce((sum, p) => sum + p.stats.totalCvits, 0);
  const openTickets = projects.reduce((sum, p) => sum + p.stats.openTickets, 0);
  const weightedBreach = projects.reduce((sum, p) => sum + p.stats.slaBreachedPct * p.stats.totalCvits, 0);
  const slaBreachedPct = totalCvits > 0 ? Math.round(weightedBreach / totalCvits) : 0;
  return { totalCvits, openTickets, slaBreachedPct, projectCount: projects.length };
}

// Attaches per-project stats (from the projects endpoint) to a rollup's project
// refs, defaulting to zeros for any project whose stats aren't in the map.
export function withStats(ref: OrgProjectRef, statsById: Map<string, ProjectStats>) {
  return { ...ref, stats: statsById.get(ref.id) ?? EMPTY_STATS };
}
