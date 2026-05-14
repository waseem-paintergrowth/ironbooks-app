import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { FlaggedQueue } from "./flagged-queue";
import { Flag } from "lucide-react";

export default async function FlaggedPage() {
  const supabase = await createServerSupabase();

  // Get all flagged actions, joined with job + client info
  const { data: actions } = await supabase
    .from("coa_actions")
    .select(`
      *,
      coa_jobs!inner (
        id,
        status,
        bookkeeper_id,
        created_at,
        flagged_for_lisa,
        client_links (
          client_name,
          jurisdiction,
          state_province
        ),
        users (
          full_name
        )
      )
    `)
    .eq("action", "flag")
    .order("created_at", { ascending: false });

  // Group by job
  const groupedByJob = new Map<string, any>();
  for (const action of actions || []) {
    const job = (action as any).coa_jobs;
    if (!job || job.status === "complete" || job.status === "cancelled") continue;

    if (!groupedByJob.has(job.id)) {
      groupedByJob.set(job.id, {
        job_id: job.id,
        client_name: job.client_links?.client_name || "Unknown",
        jurisdiction: job.client_links?.jurisdiction,
        state_province: job.client_links?.state_province,
        bookkeeper_name: job.users?.full_name || "Unknown",
        created_at: job.created_at,
        actions: [],
      });
    }
    groupedByJob.get(job.id).actions.push(action);
  }

  const jobs = Array.from(groupedByJob.values());

  return (
    <AppShell>
      <TopBar
        title="Flagged for Review"
        subtitle={`${jobs.length} job${jobs.length !== 1 ? "s" : ""} with items needing decisions`}
      />
      <div className="px-8 py-6">
        {jobs.length === 0 ? (
          <div className="rounded-xl bg-white border border-gray-200 px-8 py-16 text-center">
            <div className="rounded-full mx-auto mb-4 flex items-center justify-center w-14 h-14 bg-teal-light">
              <Flag size={24} className="text-teal" />
            </div>
            <h3 className="text-lg font-bold text-navy mb-1 tracking-tight">All clear</h3>
            <p className="text-sm text-ink-slate">
              No items currently flagged for review.
            </p>
          </div>
        ) : (
          <FlaggedQueue jobs={jobs} />
        )}
      </div>
    </AppShell>
  );
}
