import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/jobs/[id]/status
 *
 * Returns current job status + audit log entries since the last poll.
 * Used by the live execution page to show real-time progress.
 *
 * Query params:
 *   - since: ISO timestamp - only return events after this time
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;
  const { searchParams } = new URL(request.url);
  const since = searchParams.get("since");

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Get current job state
  const { data: job } = await supabase
    .from("coa_jobs")
    .select("status, execution_started_at, execution_completed_at, execution_duration_seconds, error_message, accounts_to_rename, accounts_to_create, accounts_to_delete, accounts_flagged")
    .eq("id", jobId)
    .single();

  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  // Get recent audit log entries
  let query = supabase
    .from("audit_log")
    .select("event_type, request_payload, response_payload, occurred_at, action_id")
    .eq("job_id", jobId)
    .order("occurred_at", { ascending: true })
    .limit(200);

  if (since) {
    query = query.gt("occurred_at", since);
  }

  const { data: logs } = await query;

  // Calculate progress
  const { data: actionStats } = await supabase
    .from("coa_actions")
    .select("executed")
    .eq("job_id", jobId);

  const totalActions = actionStats?.length || 0;
  const completedActions = actionStats?.filter((a) => a.executed).length || 0;
  const progressPct = totalActions > 0 ? Math.round((completedActions / totalActions) * 100) : 0;

  return NextResponse.json({
    status: job.status,
    execution_started_at: job.execution_started_at,
    execution_completed_at: job.execution_completed_at,
    duration_seconds: job.execution_duration_seconds,
    error_message: job.error_message,
    progress: {
      total: totalActions,
      completed: completedActions,
      percentage: progressPct,
    },
    stats: {
      to_rename: job.accounts_to_rename,
      to_create: job.accounts_to_create,
      to_delete: job.accounts_to_delete,
      flagged: job.accounts_flagged,
    },
    events: logs || [],
  });
}
