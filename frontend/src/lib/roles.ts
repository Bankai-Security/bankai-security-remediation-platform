import type { ProjectRole } from './api';

export function canEdit(role: ProjectRole | undefined): boolean {
  return role !== undefined && role !== 'viewer';
}

export function canManageProject(role: ProjectRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

// Org and team management use the same owner/admin gate as projects. (For
// teams, team_role never returns 'owner' — org owners/admins surface as
// 'admin' — but keeping 'owner' here is harmless and keeps the three parallel.)
export function canManageOrg(role: ProjectRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function canManageTeam(role: ProjectRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
