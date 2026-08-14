import { useState } from 'react';
import { ApiError, type MemberRole } from '../lib/api';
import './MemberManager.css';

// Reusable member + invite management surface, shared by the org and team
// settings pages (and structurally the same as the project members section in
// workspace Settings). The parent owns the data and the API calls; this only
// renders and dispatches, then calls onChanged() to let the parent refetch.

export interface ManagedMember {
  id: string;
  userId: string;
  name: string;
  email: string | null;
  role: MemberRole;
}

export interface ManagedInvite {
  id: string;
  token: string;
  email: string;
  role: Exclude<MemberRole, 'owner'>;
  createdAt: string;
  expiresAt: string;
}

type AssignableRole = Exclude<MemberRole, 'owner'>;

interface Props {
  members: ManagedMember[];
  invites: ManagedInvite[];
  canManage: boolean;
  // Path prefix for building a copy-able invite link, e.g. '/org-invites'.
  inviteBasePath: string;
  onInvite: (email: string, role: AssignableRole) => Promise<{ inviteUrl: string }>;
  onChangeRole: (memberId: string, role: AssignableRole) => Promise<void>;
  onRemove: (memberId: string) => Promise<void>;
  onRevoke: (inviteId: string) => Promise<void>;
  // Revokes the pending invite and issues a fresh link — the only way to
  // renew an expired one.
  onResend: (inviteId: string) => Promise<{ inviteUrl: string }>;
  onChanged: () => void;
}

const AVATAR_COLORS = ['#22C55E', '#2563EB', '#7C3AED', '#EA580C', '#DB2777', '#0D9488', '#CA8A04'];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (name.includes('@')) return name[0]!.toUpperCase();
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Invites expire 14 days after they're issued. An expired one still shows in
// the pending list (so it's clear why the link stopped working) but is marked
// and can only be renewed with Resend.
function expiryLabel(iso: string): { text: string; expired: boolean } {
  const msLeft = new Date(iso).getTime() - Date.now();
  if (msLeft <= 0) return { text: 'Expired', expired: true };
  const days = Math.ceil(msLeft / (24 * 60 * 60 * 1000));
  return { text: days === 1 ? 'Expires in 1 day' : `Expires in ${days} days`, expired: false };
}

const ROLE_BADGE: Record<MemberRole, string> = {
  owner: 'mm-role--owner',
  admin: 'mm-role--admin',
  editor: 'mm-role--editor',
  viewer: 'mm-role--viewer',
};

export default function MemberManager({
  members,
  invites,
  canManage,
  inviteBasePath,
  onInvite,
  onChangeRole,
  onRemove,
  onRevoke,
  onResend,
  onChanged,
}: Props) {
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<AssignableRole>('editor');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard may be unavailable; the link is still visible to select manually */
    }
  };

  const submitInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setInviteBusy(true);
    setInviteError(null);
    try {
      const { inviteUrl } = await onInvite(inviteEmail.trim(), inviteRole);
      setGeneratedUrl(inviteUrl);
      setInviteEmail('');
      onChanged();
    } catch (err) {
      setInviteError(err instanceof ApiError ? (err.fieldErrors?.[0]?.message ?? err.message) : 'Could not create this invite.');
    } finally {
      setInviteBusy(false);
    }
  };

  const changeRole = async (memberId: string, role: AssignableRole) => {
    setBusyId(memberId);
    try {
      await onChangeRole(memberId, role);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (memberId: string) => {
    setBusyId(memberId);
    try {
      await onRemove(memberId);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const revoke = async (inviteId: string) => {
    setBusyId(inviteId);
    try {
      await onRevoke(inviteId);
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const resend = async (inviteId: string) => {
    setBusyId(inviteId);
    setInviteError(null);
    try {
      const { inviteUrl } = await onResend(inviteId);
      // Surface the new link straight away — the old one is now dead, so the
      // admin needs to re-send this one.
      setGeneratedUrl(inviteUrl);
      setShowInvite(true);
      onChanged();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : 'Could not resend this invite.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mm">
      <div className="mm-header">
        <div className="mm-count">{members.length} {members.length === 1 ? 'member' : 'members'}</div>
        {canManage && !showInvite && (
          <button type="button" className="ws-btn ws-btn-secondary mm-invite-toggle" onClick={() => { setShowInvite(true); setGeneratedUrl(null); }}>
            Invite member
          </button>
        )}
      </div>

      {canManage && showInvite && (
        <div className="mm-invite-card">
          {generatedUrl ? (
            <>
              <div className="mm-invite-label">Invite link — copy and send this yourself (no email is sent).</div>
              <div className="mm-invite-url-row">
                <input className="mm-invite-url" readOnly value={generatedUrl} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="ws-btn ws-btn-secondary" onClick={() => void copy(generatedUrl, 'gen')}>
                  {copied === 'gen' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <button type="button" className="ws-btn ws-btn-primary mm-invite-done" onClick={() => { setShowInvite(false); setGeneratedUrl(null); }}>
                Done
              </button>
            </>
          ) : (
            <form onSubmit={submitInvite}>
              {inviteError && <div className="mm-error" role="alert">{inviteError}</div>}
              <div className="mm-invite-form">
                <input
                  type="email"
                  required
                  placeholder="person@company.com"
                  className="mm-input"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                />
                <select className="ws-select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as AssignableRole)}>
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
                <button type="submit" className="ws-btn ws-btn-primary" disabled={inviteBusy}>
                  {inviteBusy ? 'Inviting…' : 'Create invite'}
                </button>
                <button type="button" className="ws-btn ws-btn-secondary" onClick={() => { setShowInvite(false); setInviteError(null); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <div className="mm-list">
        {members.map((m) => {
          const isOwner = m.role === 'owner';
          const canEditThis = canManage && !isOwner;
          return (
            <div key={m.id} className="mm-row">
              <div className="ws-avatar-chip" style={{ background: avatarColor(m.userId || m.email || m.id) }}>{initials(m.name)}</div>
              <div className="mm-row-id">
                <div className="mm-row-name">{m.name}</div>
                {m.email && <div className="mm-row-email">{m.email}</div>}
              </div>
              {canEditThis ? (
                <select
                  className="ws-select mm-row-role-select"
                  value={m.role}
                  disabled={busyId === m.id}
                  onChange={(e) => void changeRole(m.id, e.target.value as AssignableRole)}
                >
                  <option value="admin">Admin</option>
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <span className={`ws-badge ${ROLE_BADGE[m.role]}`}>{m.role}</span>
              )}
              {canEditThis ? (
                <button type="button" className="mm-remove" disabled={busyId === m.id} onClick={() => void remove(m.id)}>
                  Remove
                </button>
              ) : (
                <span className="mm-remove-spacer" />
              )}
            </div>
          );
        })}
      </div>

      {invites.length > 0 && (
        <div className="mm-invites">
          <div className="mm-invites-title">Pending invites</div>
          {invites.map((inv) => {
            const link = `${window.location.origin}${inviteBasePath}/${inv.token}`;
            const expiry = expiryLabel(inv.expiresAt);
            return (
              <div key={inv.id} className="mm-row mm-row--invite">
                <div className="mm-row-id">
                  <div className="mm-row-name">{inv.email}</div>
                  <div className="mm-row-email">
                    Invited {formatDate(inv.createdAt)}
                    {' · '}
                    <span className={expiry.expired ? 'mm-expired' : undefined}>{expiry.text}</span>
                  </div>
                </div>
                <span className={`ws-badge ${ROLE_BADGE[inv.role]}`}>{inv.role}</span>
                {/* An expired link is dead — offer Resend instead of Copy. */}
                {expiry.expired ? (
                  <span className="mm-link-placeholder" />
                ) : (
                  <button type="button" className="mm-link-btn" onClick={() => void copy(link, inv.id)}>
                    {copied === inv.id ? 'Copied' : 'Copy link'}
                  </button>
                )}
                {canManage && (
                  <>
                    <button type="button" className="mm-link-btn" disabled={busyId === inv.id} onClick={() => void resend(inv.id)}>
                      Resend
                    </button>
                    <button type="button" className="mm-remove" disabled={busyId === inv.id} onClick={() => void revoke(inv.id)}>
                      Revoke
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
