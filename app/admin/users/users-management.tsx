"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { UserPlus, MoreVertical, Power, PowerOff, ChevronDown, Loader2, Mail, X, Shield, Crown, User as UserIcon, Eye, CheckCircle2 } from "lucide-react";

interface UserStats {
  id: string;
  email: string;
  full_name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  total_cleanups: number;
  completed_cleanups: number;
  active_cleanups: number;
  failed_cleanups: number;
  cleanups_this_week: number;
  cleanups_this_month: number;
  avg_duration_seconds: number | null;
  total_rules_pushed: number;
  flags_reviewed: number;
  last_activity_at: string | null;
}

export function UsersManagement({ initialUsers }: { initialUsers: UserStats[] }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [showInvite, setShowInvite] = useState(false);

  async function updateUser(userId: string, updates: { role?: string; is_active?: boolean }) {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Failed: ${error}`);
      return;
    }

    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, ...updates } : u))
    );
    router.refresh();
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowInvite(true)}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg"
        >
          <UserPlus size={16} />
          Invite Team Member
        </button>
      </div>

      <div className="rounded-xl overflow-hidden bg-white border border-gray-200">
        <div
          className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
          style={{ gridTemplateColumns: "2fr 1fr 1fr 0.8fr 0.8fr 1fr 0.6fr" }}
        >
          <div>User</div>
          <div>Role</div>
          <div>Cleanups</div>
          <div>This Week</div>
          <div>Rules</div>
          <div>Last Active</div>
          <div></div>
        </div>

        {users.map((u) => (
          <UserRow key={u.id} user={u} onUpdate={(updates) => updateUser(u.id, updates)} />
        ))}

        {users.length === 0 && (
          <p className="py-12 text-center text-sm text-ink-slate">No users yet. Invite your first team member.</p>
        )}
      </div>

      {showInvite && <InviteModal onClose={() => { setShowInvite(false); router.refresh(); }} />}
    </div>
  );
}

function UserRow({
  user,
  onUpdate,
}: {
  user: UserStats;
  onUpdate: (updates: { role?: string; is_active?: boolean }) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);

  const roleConfig: Record<string, { icon: any; color: string; bg: string }> = {
    admin: { icon: Crown, color: "#7C3AED", bg: "#EDE9FE" },
    lead: { icon: Shield, color: "#2D7A75", bg: "#E8F2F0" },
    bookkeeper: { icon: UserIcon, color: "#475569", bg: "#F1F5F9" },
    viewer: { icon: Eye, color: "#94A3B8", bg: "#F8FAFC" },
  };
  const rc = roleConfig[user.role] || roleConfig.bookkeeper;
  const RoleIcon = rc.icon;

  return (
    <div
      className={`grid items-center px-5 py-3.5 border-b border-gray-100 hover:bg-teal-lighter transition-colors ${
        !user.is_active ? "opacity-50" : ""
      }`}
      style={{ gridTemplateColumns: "2fr 1fr 1fr 0.8fr 0.8fr 1fr 0.6fr" }}
    >
      <Link href={`/admin/users/${user.id}`} className="flex items-center gap-3 min-w-0">
        <div className="rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 w-9 h-9 bg-teal-light text-teal">
          {user.full_name?.charAt(0) || "?"}
        </div>
        <div className="min-w-0">
          <div className="font-semibold text-sm text-navy truncate">{user.full_name}</div>
          <div className="text-xs text-ink-slate truncate">{user.email}</div>
        </div>
      </Link>

      <div className="relative">
        <button
          onClick={() => setRoleMenuOpen(!roleMenuOpen)}
          disabled={!user.is_active}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold capitalize"
          style={{ color: rc.color, backgroundColor: rc.bg }}
        >
          <RoleIcon size={12} />
          {user.role}
          <ChevronDown size={11} />
        </button>

        {roleMenuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setRoleMenuOpen(false)} />
            <div className="absolute left-0 top-full mt-1 z-20 rounded-lg shadow-lg overflow-hidden bg-white border border-gray-200 min-w-[140px]">
              {(["admin", "lead", "bookkeeper", "viewer"] as const).map((r) => {
                const rcc = roleConfig[r];
                const Ricon = rcc.icon;
                const isCurrent = r === user.role;
                return (
                  <button
                    key={r}
                    onClick={() => {
                      if (!isCurrent) onUpdate({ role: r });
                      setRoleMenuOpen(false);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
                    style={{ color: rcc.color }}
                  >
                    <Ricon size={12} />
                    <span className="capitalize">{r}</span>
                    {isCurrent && <CheckCircle2 size={12} className="ml-auto" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <div>
        <div className="text-sm font-bold text-navy">{user.completed_cleanups || 0}</div>
        <div className="text-xs text-ink-slate">
          {user.active_cleanups || 0} active
          {user.failed_cleanups > 0 && (
            <span className="text-red-600"> · {user.failed_cleanups} failed</span>
          )}
        </div>
      </div>

      <div className="text-sm font-bold text-navy">{user.cleanups_this_week || 0}</div>

      <div>
        <div className="text-sm font-bold text-navy">{user.total_rules_pushed || 0}</div>
        <div className="text-xs text-ink-slate">{user.flags_reviewed} flags</div>
      </div>

      <div className="text-xs text-ink-slate">
        {user.last_activity_at ? formatTimeAgo(user.last_activity_at) : "Never"}
      </div>

      <div className="relative flex justify-end">
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="p-1.5 rounded-md hover:bg-gray-100"
        >
          <MoreVertical size={14} className="text-ink-slate" />
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-1 z-20 rounded-lg shadow-lg overflow-hidden bg-white border border-gray-200 min-w-[170px]">
              <Link
                href={`/admin/users/${user.id}`}
                className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
              >
                View activity
              </Link>
              <button
                onClick={() => {
                  onUpdate({ is_active: !user.is_active });
                  setMenuOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-teal-lighter text-navy"
              >
                {user.is_active ? (
                  <>
                    <PowerOff size={12} className="text-red-600" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <Power size={12} className="text-green-600" />
                    Reactivate
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState("bookkeeper");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setSending(true);
    setError(null);

    const res = await fetch("/api/admin/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, full_name: name, role }),
    });

    if (res.ok) {
      setSent(true);
    } else {
      const { error: errMsg } = await res.json();
      setError(errMsg);
    }
    setSending(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-md w-full">
        <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-teal-light">
              <Mail size={18} className="text-teal" />
            </div>
            <h3 className="text-lg font-bold text-navy">Invite Team Member</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100">
            <X size={18} className="text-ink-slate" />
          </button>
        </div>

        {sent ? (
          <div className="p-6 text-center">
            <CheckCircle2 size={36} className="text-green-500 mx-auto mb-3" />
            <h4 className="font-bold text-navy mb-1">Invite sent</h4>
            <p className="text-sm text-ink-slate mb-4">
              {email} will receive a magic-link email to sign in.
            </p>
            <button
              onClick={onClose}
              className="bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-5 py-2 rounded-lg"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Full name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Lisa Smith"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Email
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="lisa@ironbooks.com"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">
                Role
              </label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy bg-white"
              >
                <option value="bookkeeper">Bookkeeper — does cleanups</option>
                <option value="lead">Lead — reviews flagged items + audit log</option>
                <option value="viewer">Viewer — read-only</option>
                <option value="admin">Admin — full access incl. user management</option>
              </select>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={onClose}
                className="text-sm font-semibold text-ink-slate hover:text-navy px-3 py-2"
              >
                Cancel
              </button>
              <button
                onClick={send}
                disabled={sending || !email || !name}
                className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg"
              >
                {sending ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                {sending ? "Sending..." : "Send Invite"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
