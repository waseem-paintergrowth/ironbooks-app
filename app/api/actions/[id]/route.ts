import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/actions/[id]
 *
 * Updates a coa_action's decision (used by Lisa's flagged queue).
 * Records the override + adds a note to the audit log.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: actionId } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { action, new_name, notes } = body;

  if (!["keep", "rename", "delete", "flag"].includes(action)) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }

  // Update the action
  const { data: updated, error } = await supabase
    .from("coa_actions")
    .update({
      action,
      new_name: new_name || null,
      bookkeeper_override: true,
      flagged_reason: action === "flag" ? notes || null : null,
    })
    .eq("id", actionId)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message || "Update failed" }, { status: 500 });
  }

  // Audit log
  await supabase.from("audit_log").insert({
    job_id: updated.job_id,
    action_id: actionId,
    user_id: user.id,
    event_type: "action_resolved",
    request_payload: {
      message: `Resolved flag: ${updated.current_name} → ${action}${new_name ? ` (${new_name})` : ""}`,
      notes,
    } as any,
  });

  // Check if all flags on this job are resolved
  const { data: stillFlagged } = await supabase
    .from("coa_actions")
    .select("id")
    .eq("job_id", updated.job_id)
    .eq("action", "flag");

  if (!stillFlagged || stillFlagged.length === 0) {
    // No more flags - update job
    await supabase
      .from("coa_jobs")
      .update({
        flagged_for_lisa: false,
        lisa_reviewed_at: new Date().toISOString(),
        lisa_reviewed_by: user.id,
      })
      .eq("id", updated.job_id);
  }

  return NextResponse.json({ success: true, action: updated });
}
