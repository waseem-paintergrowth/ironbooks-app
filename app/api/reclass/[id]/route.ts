import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/reclass/[id]
 *
 * Update job-level fields:
 *  - attested (boolean) — bookkeeper attestation
 *  - force_reconciled (boolean) — admin-only override to include reconciled txs
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: actor } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  const service = createServiceSupabase();

  const updates: Record<string, any> = {};

  if ("attested" in body) {
    updates.attested = !!body.attested;
    updates.attested_at = body.attested ? new Date().toISOString() : null;
  }

  if ("force_reconciled" in body) {
    if (actor.role !== "admin") {
      return NextResponse.json(
        { error: "Only admins can enable force_reconciled override" },
        { status: 403 }
      );
    }
    updates.force_reconciled = !!body.force_reconciled;
    if (body.force_reconciled) {
      updates.force_reconciled_by = user.id;
      updates.force_reconciled_at = new Date().toISOString();
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
  }

  const { data, error } = await service
    .from("reclass_jobs")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If force_reconciled was just enabled, un-skip the reconciled rows so they become pending again
  if (updates.force_reconciled === true) {
    await service
      .from("reclassifications")
      .update({
        decision: "needs_review",
        status: "pending",
      } as any)
      .eq("reclass_job_id", id)
      .eq("skip_reason", "reconciled");

    // Recompute stats
    const { count: nowReviewing } = await service
      .from("reclassifications")
      .select("*", { count: "exact", head: true })
      .eq("reclass_job_id", id)
      .eq("decision", "needs_review");

    const { count: stillSkippedReconciled } = await service
      .from("reclassifications")
      .select("*", { count: "exact", head: true })
      .eq("reclass_job_id", id)
      .eq("skip_reason", "reconciled");

    await service
      .from("reclass_jobs")
      .update({
        transactions_needs_review: nowReviewing || 0,
        transactions_skipped_reconciled: stillSkippedReconciled || 0,
      } as any)
      .eq("id", id);
  }

  return NextResponse.json({ job: data });
}
