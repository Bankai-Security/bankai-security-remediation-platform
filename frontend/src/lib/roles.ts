import type { ProjectRole } from './api';

export function canEdit(role: ProjectRole | undefined): boolean {
  return role !== undefined && role !== 'viewer';
}

export function canManageProject(role: ProjectRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}
