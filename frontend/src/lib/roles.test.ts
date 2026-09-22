import { describe, expect, it } from 'vitest';
import { canEdit, canManageOrg, canManageProject, canManageTeam } from './roles';

describe('role controls', () => {
  it.each(['owner', 'admin', 'editor'] as const)('allows %s to edit', (role) => {
    expect(canEdit(role)).toBe(true);
  });

  it.each([undefined, 'viewer'] as const)('does not allow %s to edit', (role) => {
    expect(canEdit(role)).toBe(false);
  });

  it.each(['owner', 'admin'] as const)('allows %s to manage each hierarchy level', (role) => {
    expect(canManageProject(role)).toBe(true);
    expect(canManageOrg(role)).toBe(true);
    expect(canManageTeam(role)).toBe(true);
  });

  it.each([undefined, 'viewer', 'editor'] as const)('denies management controls to %s', (role) => {
    expect(canManageProject(role)).toBe(false);
    expect(canManageOrg(role)).toBe(false);
    expect(canManageTeam(role)).toBe(false);
  });
});
