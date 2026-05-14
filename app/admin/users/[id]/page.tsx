import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Crown, Shield, User as UserIcon, Eye, FileCheck, Zap, Flag, Clock, Activity } from "lucide-react";

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const [
    { data: userStats },
    { data: recentJobs },
    { data: recentActivity },
  ] = await Promise.all([
    supabase.from("user_activity_stats").select("*").eq("id", id).single(),
    supabase
      .from("coa_jobs")
      .select("id, status, created_at, execution_completed_at, execution_duration_seconds, accounts_to_rename, accounts_to_create, error_message, client_links(client_name, jurisdiction)")
      .eq("bookkeeper_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("recent_activity_feed")
      .select("*")
      .eq("user_id", id)
      .limit(50),
  ]);

  if (!userStats) notFound();

  const roleConfig: Record<string, { icon: any; color: string; bg: string }> = {
    admin: { icon: Crown, color: "#7C3AED", bg: "#EDE9FE" },
    lead: { icon: Shield, color: "#2D7A75", bg: "#E8F2F0" },
    bookkeeper: { icon: UserIcon, color: "#475569", bg: "#F1F5F9" },
    viewer: { icon: Eye, color: "#94A3B8", bg: "#F8FAFC" },
  };
  const rc = roleConfig[userStats.role || "bookkeeper"];
  const RoleIcon = rc.icon;

  return (
    <AppShell>
      <TopBar
        title={userStats.full_name || "User"}
        subtitle={userStats.email}
        actions={
          <Link
            href="/admin/users"
            className="inline-flex items-center gap-2 text-sm font-semibold text-ink-slate hover:text-navy"
          >
            <ArrowLeft size={14} />
            All users
          </Link>
        }
      />

      <div className="px-8 py-6">
        {/* Profile card */}
        <div className="rounded-xl bg-white border border-gray-200 p-6 mb-6 flex items-center gap-6">
          <div className="rounded-full flex items-center justify-center font-bold text-2xl flex-shrink-0 w-20 h-20 bg-teal-light text-teal">
            {userStats.full_name?.charAt(0) || "?"}
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold tracking-tight text-navy mb-1">
              {userStats.full_name}
            </h2>
            <p className="text-sm text-ink-slate mb-2">{userStats.email}</p>
            <div className="flex items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold capitalize"
                style={{ color: rc.color, backgroundColor: rc.bg }}
              >
                <RoleIcon size={12} />
                {userStats.role}
              </span>
              <span
                className={`text-xs font-semibold ${
                  userStats.is_active ? "text-green-600" : "text-red-600"
                }`}
              >
                {userStats.is_active ? "● Active" : "● Inactive"}
              </span>
              <span className="text-xs text-ink-slate">
                Member since {new Date(userStats.created_at!).toLocaleDateString()}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-ink-slate mb-1">Last active</div>
            <div className="text-sm font-bold text-navy">
              {userStats.last_activity_at
                ? formatTimeAgo(userStats.last_activity_at)
                : "Never"}
            </div>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <StatBox
            label="Completed Cleanups"
            value={userStats.completed_cleanups ?? 0}
            sub={`${userStats.active_cleanups ?? 0} active`}
            icon={FileCheck}
            color="#10B981"
          />
          <StatBox
            label="This Week"
            value={userStats.cleanups_this_week ?? 0}
            sub={`${userStats.cleanups_this_month ?? 0} this month`}
            icon={Activity}
            color="#2D7A75"
          />
          <StatBox
            label="Rules Pushed"
            value={userStats.total_rules_pushed ?? 0}
            sub="to QuickBooks"
            icon={Zap}
            color="#F59E0B"
          />
          <StatBox
            label="Flags Reviewed"
            value={userStats.flags_reviewed ?? 0}
            sub={userStats.avg_duration_seconds ? `Avg ${Math.round(userStats.avg_duration_seconds / 60)}m` : ""}
            icon={Flag}
            color="#7C3AED"
          />
        </div>

        <div className="grid grid-cols-2 gap-6">
          {/* Recent jobs */}
          <div className="rounded-xl bg-white border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="font-bold text-sm text-navy">Recent Cleanup Jobs</h3>
            </div>
            <div className="divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
              {recentJobs?.map((job: any) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}/review`}
                  className="flex items-center px-5 py-3 hover:bg-teal-lighter transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-navy truncate">
                      {job.client_links?.client_name || "Unknown client"}
                    </div>
                    <div className="text-xs text-ink-slate">
                      {job.client_links?.jurisdiction} •{" "}
                      {new Date(job.created_at).toLocaleDateString()}
                      {job.execution_duration_seconds && (
                        <span> • {Math.round(job.execution_duration_seconds / 60)}m</span>
                      )}
                    </div>
                  </div>
                  <span
                    className="px-2 py-0.5 rounded text-xs font-semibold capitalize"
                    style={{
                      backgroundColor:
                        job.status === "complete" ? "#D1FAE5" :
                        job.status === "failed" ? "#FEE2E2" :
                        "#FEF3C7",
                      color:
                        job.status === "complete" ? "#10B981" :
                        job.status === "failed" ? "#DC2626" :
                        "#F59E0B",
                    }}
                  >
                    {job.status.replace("_", " ")}
                  </span>
                </Link>
              ))}
              {(!recentJobs || recentJobs.length === 0) && (
                <p className="px-5 py-8 text-center text-sm text-ink-slate">
                  No jobs yet.
                </p>
              )}
            </div>
          </div>

          {/* Activity timeline */}
          <div className="rounded-xl bg-white border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="font-bold text-sm text-navy">Activity Timeline</h3>
            </div>
            <div className="divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
              {recentActivity?.map((event: any) => (
                <div key={event.id} className="px-5 py-3 text-xs">
                  <div className="flex items-start gap-2">
                    <Clock size={11} className="text-ink-light mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-navy">
                        {formatEventType(event.event_type)}
                        {event.client_name && (
                          <span className="text-ink-slate"> on {event.client_name}</span>
                        )}
                      </div>
                      <div className="text-ink-light mt-0.5">
                        {formatTimeAgo(event.occurred_at)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {(!recentActivity || recentActivity.length === 0) && (
                <p className="px-5 py-8 text-center text-sm text-ink-slate">
                  No activity yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function StatBox({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  sub: string;
  icon: any;
  color: string;
}) {
  return (
    <div className="p-4 rounded-xl bg-white border border-gray-200">
      <div className="flex items-start justify-between mb-2">
        <div className="p-1.5 rounded-md" style={{ backgroundColor: `${color}15` }}>
          <Icon size={14} style={{ color }} />
        </div>
      </div>
      <div className="text-2xl font-bold tracking-tight text-navy">{value}</div>
      <div className="text-xs text-ink-slate mt-0.5">{label}</div>
      {sub && <div className="text-xs text-ink-light mt-0.5">{sub}</div>}
    </div>
  );
}

function formatEventType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/qbo /g, "QBO ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatTimeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
