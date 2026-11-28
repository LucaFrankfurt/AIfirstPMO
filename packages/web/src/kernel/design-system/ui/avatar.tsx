/** People: a face, or initials on a colour solved for contrast, and a few of them overlapping. */
import { colorFor, initials } from '../format';
import { fileSrc } from '../../sync/server';

export function Avatar({ user, size = 22 }: { user?: { id: string; name?: string; avatar_url?: string | null }; size?: number }) {
  if (!user) {
    return (
      <span className="avatar" style={{ width: size, height: size, background: 'var(--bg-active)', color: 'var(--fg-muted)', fontSize: size * 0.45 }}>
        ?
      </span>
    );
  }
  return (
    <span
      className="avatar"
      title={user.name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        // Quoted: an upload's name is encoded with `encodeURIComponent`, which
        // leaves parentheses alone, and one of those ends an unquoted `url()`.
        background: user.avatar_url ? `center/cover url("${fileSrc(user.avatar_url)}")` : colorFor(user.id),
      }}
    >
      {user.avatar_url ? '' : initials(user.name)}
    </span>
  );
}

export function AvatarStack({ users, size = 22, max = 3 }: { users: any[]; size?: number; max?: number }) {
  if (!users.length) return null;
  return (
    <span className="avatar-stack">
      {users.slice(0, max).map((user) => <Avatar key={user.id} user={user} size={size} />)}
      {users.length > max && (
        <span className="avatar" style={{ width: size, height: size, background: 'var(--bg-active)', color: 'var(--fg-soft)', fontSize: size * 0.4 }}>
          +{users.length - max}
        </span>
      )}
    </span>
  );
}
