import { useEffect, useMemo, useState } from 'react';
import { ApiError, listMyGithubRepos, type GithubUserRepo } from '../lib/api';
import './RepoPicker.css';

interface RepoPickerProps {
  onSelect: (repo: GithubUserRepo) => void;
  selectedFullName?: string | null;
}

// Client-side filter over an already-fetched, capped repo list (see
// listAuthenticatedUserRepos in the backend) rather than a live search —
// no searchable/combobox component exists elsewhere in this app to reuse,
// so this stays deliberately simple and matches the rest of the app's
// plain ws-* styling instead of pulling in a new UI library.
export default function RepoPicker({ onSelect, selectedFullName }: RepoPickerProps) {
  const [repos, setRepos] = useState<GithubUserRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    listMyGithubRepos()
      .then(({ repos: fetched }) => {
        if (!cancelled) setRepos(fetched);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load your repositories.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  if (error) {
    return <div className="repo-picker-error">{error}</div>;
  }

  return (
    <div className="repo-picker">
      <input
        type="text"
        className="ws-select repo-picker-search"
        placeholder={repos ? `Search ${repos.length} repositories…` : 'Loading your repositories…'}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={!repos}
      />
      <div className="repo-picker-list">
        {repos === null ? (
          <div className="repo-picker-empty">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="repo-picker-empty">No repositories match &quot;{query}&quot;.</div>
        ) : (
          filtered.map((repo) => (
            <button
              type="button"
              key={repo.fullName}
              className={`repo-picker-item ${selectedFullName === repo.fullName ? 'repo-picker-item--selected' : ''}`}
              onClick={() => onSelect(repo)}
            >
              <span className="repo-picker-item-name">{repo.fullName}</span>
              <span className={`ws-badge ${repo.private ? 'ws-badge--pill-neutral' : 'ws-badge--pill-green'}`}>
                {repo.private ? 'Private' : 'Public'}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
