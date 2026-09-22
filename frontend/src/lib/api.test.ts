import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteOrg, listFindings, login, uploadScan } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('normalizes field validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Invalid request data',
      details: [{ path: 'email', message: 'Enter a valid email address' }],
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })));

    await expect(login({ email: 'bad', password: 'secret' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
      fieldErrors: [{ path: 'email', message: 'Enter a valid email address' }],
    });
  });

  it('uses a safe fallback when an error response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway failure', { status: 502 })));
    const error = await listFindings('project-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, message: 'Something went wrong. Please try again.' });
  });

  it('does not set Content-Type for multipart uploads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ scan: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await uploadScan('project-1', new File(['finding'], 'findings.csv', { type: 'text/csv' }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Content-Type');
  });

  it('preserves structured conflict details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Organization is not empty', details: { projectCount: 3 },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })));
    const error = await deleteOrg('org-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).projectCount).toBe(3);
  });
});
