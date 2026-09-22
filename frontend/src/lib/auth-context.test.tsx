import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { AuthProvider, getDisplayName, getInitials, useCurrentUser } from './auth-context';

function Probe() {
  const { user, loading } = useCurrentUser();
  return <div>{loading ? 'loading' : user?.email ?? 'anonymous'}</div>;
}

describe('authentication context', () => {
  it('renders loading then the authenticated session', async () => {
    let resolveSession!: (value: { user: api.PublicUser }) => void;
    vi.spyOn(api, 'getSession').mockReturnValue(new Promise((resolve) => { resolveSession = resolve; }));
    render(<AuthProvider><Probe /></AuthProvider>);
    expect(screen.getByText('loading')).toBeInTheDocument();
    resolveSession({ user: { id: '1', email: 'ada@example.com', fullName: 'Ada Lovelace', hasPassword: true } });
    await waitFor(() => expect(screen.getByText('ada@example.com')).toBeInTheDocument());
  });

  it('settles as anonymous when the session API fails', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(new Error('offline'));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anonymous')).toBeInTheDocument());
  });

  it('derives accessible display fallbacks without exposing identifiers unnecessarily', () => {
    expect(getInitials({ id: '1', email: 'ada@example.com', fullName: 'Ada Lovelace', hasPassword: true })).toBe('AL');
    expect(getInitials({ id: '1', email: 'ada@example.com', fullName: null, hasPassword: true })).toBe('A');
    expect(getDisplayName(null)).toBe('Account');
  });
});
