import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken } from "@/lib/qbo";
import { analyzeCOA, type MasterCOAEntry } from "@/lib/claude";
import { NextResponse } from "next/server";

// Allow up to 5 minutes for analysis - large client COAs (~200 accounts)
// require multiple sequential Claude calls, each taking 10-20s.
// Requires Vercel Pro plan or higher.
export const maxDuration = 300;

/**
 * POST /api/jobs/[id]/analyze
 *
 * 1. Fetches the client's current COA from QBO
 * 2. Loads the IronBooks master COA for the jurisdiction
 * 3. Calls Claude to generate suggestions
 * 4. Persists everything in coa_jobs + coa_actions
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: jobId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Use service client for the heavy work (bypasses RLS for system operations)
  const service = createServiceSupabase();

  // 1. Load the job + client info
  const { data: job, error: jobErr } = await service
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();

  if (jobErr || !job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const clientLink = (job as any).client_links;
  if (!clientLink) {
    return NextResponse.json({ error: "Client link missing" }, { status: 400 });
  }

  try {
    // 2. Get valid QBO token (auto-refreshes)
    const accessToken = await getValidToken(clientLink.id, service as any);

    // 3. Fetch QBO COA
    const qboAccounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);

    // 4. Load master COA for jurisdiction
    const { data: masterRows } = await service
      .from("master_coa")
      .select("*")
      .eq("jurisdiction", clientLink.jurisdiction)
      .order("sort_order");

    const masterCOA: MasterCOAEntry[] = (masterRows || []).map((m) => ({
      account_name: m.account_name,
      parent_account_name: m.parent_account_name,
      is_parent: m.is_parent ?? false,
      qbo_account_type: m.qbo_account_type,
      qbo_account_subtype: m.qbo_account_subtype,
      section: m.section,
      notes: m.notes || "",
      is_required: m.is_required ?? false,
      tax_treatment: m.tax_treatment,
    }));

    // 5. Run Claude analysis
    const analysis = await analyzeCOA({
      clientName: clientLink.client_name,
      jurisdiction: clientLink.jurisdiction,
      stateProvince: clientLink.state_province || "",
      clientAccounts: qboAccounts,
      masterCOA,
    });

    // 6. Persist - update job
    await service.from("coa_jobs").update({
      status: "in_review",
      current_coa_snapshot: qboAccounts as any,
      snapshot_pulled_at: new Date().toISOString(),
      ai_suggestions: analysis as any,
      ai_model_used: "claude-opus-4-7",
      ai_completed_at: new Date().toISOString(),
      accounts_to_rename: analysis.suggestions.filter(s => s.action === "rename").length,
      accounts_to_delete: analysis.suggestions.filter(s => s.action === "delete").length,
      accounts_flagged: analysis.suggestions.filter(s => s.action === "flag").length,
      accounts_to_create: analysis.missing_required_accounts.length,
      flagged_for_lisa: analysis.suggestions.some(s => s.action === "flag"),
    }).eq("id", jobId);

    // 7. Create individual action rows
    const actions = analysis.suggestions.map((s, idx) => ({
      job_id: jobId,
      qbo_account_id: s.qbo_account_id,
      current_name: s.current_name,
      action: s.action,
      new_name: s.target_master_account || null,
      ai_confidence: s.confidence,
      ai_reasoning: s.reasoning,
      ai_suggested_target: s.target_master_account || null,
      flagged_reason: s.flag_reason || null,
      sort_order: idx,
    }));

    // Add "create" actions for missing required accounts
    const missingActions = analysis.missing_required_accounts.map((name, idx) => {
      const masterEntry = masterCOA.find(m => m.account_name === name);
      return {
        job_id: jobId,
        action: "create" as const,
        new_name: name,
        new_type: masterEntry?.qbo_account_type,
        new_subtype: masterEntry?.qbo_account_subtype,
        new_parent_name: masterEntry?.parent_account_name,
        ai_confidence: 1.0,
        ai_reasoning: "Required master account missing from client COA",
        sort_order: actions.length + idx,
      };
    });

    await service.from("coa_actions").insert([...actions, ...missingActions] as any);

    return NextResponse.json({
      success: true,
      job_id: jobId,
      stats: {
        client_accounts: qboAccounts.length,
        suggestions: analysis.suggestions.length,
        missing_accounts: analysis.missing_required_accounts.length,
        warnings: analysis.warnings.length,
      },
      summary: analysis.summary,
    });
  } catch (error: any) {
    console.error("Analysis failed:", error);

    await service.from("coa_jobs").update({
      status: "failed",
      error_message: error.message,
    }).eq("id", jobId);

    return NextResponse.json(
      { error: error.message },
      { status: 500 }
    );
  }
}
