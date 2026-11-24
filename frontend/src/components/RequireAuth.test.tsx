import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import * as api from '../lib/api';
import { AuthProvider } from '../lib/auth-context';
import RequireAuth from './RequireAuth';

describe('RequireAuth', () => {
  it('redirects signed-out visitors away from protected pages', async () => {
    vi.spyOn(api, 'getSession').mockRejectedValue(new api.ApiError(401, 'Not authenticated'));
    render(<MemoryRouter initialEntries={['/projects']}><AuthProvider><Routes>
      <Route path="/login" element={<div>Login screen</div>} />
      <Route element={<RequireAuth />}><Route path="/projects" element={<div>Private projects</div>} /></Route>
    </Routes></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Login screen')).toBeInTheDocument());
    expect(screen.queryByText('Private projects')).not.toBeInTheDocument();
  });

  it('allows a restored session to access protected pages', async () => {
    vi.spyOn(api, 'getSession').mockResolvedValue({ user: { id: '1', email: 'ada@example.com', fullName: null, hasPassword: true } });
    render(<MemoryRouter initialEntries={['/projects']}><AuthProvider><Routes>
      <Route path="/login" element={<div>Login screen</div>} />
      <Route element={<RequireAuth />}><Route path="/projects" element={<div>Private projects</div>} /></Route>
    </Routes></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Private projects')).toBeInTheDocument());
  });
});
