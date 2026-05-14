import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo";
import { fetchRecentTransactions, groupByVendor } from "@/lib/qbo-rules";
import { analyzeBankRules } from "@/lib/claude-rules";
import { NextResponse, after } from "next/server";

/**
 * POST /api/rules/discover
 *
 * Body: { client_link_id: string, months: number }
 *
 * Creates a rule_discovery_jobs row, kicks off background analysis,
 * returns immediately with the job ID.
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { client_link_id, months = 6 } = await request.json();
  if (!client_link_id) {
    return NextResponse.json({ error: "client_link_id required" }, { status: 400 });
  }

  // Create the job row
  const service = createServiceSupabase();
  const { data: job, error } = await service
    .from("rule_discovery_jobs")
    .insert({
      client_link_id,
      bookkeeper_id: user.id,
      status: "executing",
      months_analyzed: months,
    } as any)
    .select()
    .single();

  if (error || !job) {
    return NextResponse.json({ error: error?.message }, { status: 500 });
  }

  // Background: pull transactions + analyze
  after(async () => {
    try {
      await runDiscovery(job.id, client_link_id, months);
    } catch (err: any) {
      console.error(`Discovery failed for job ${job.id}:`, err);
      await service
        .from("rule_discovery_jobs")
        .update({
          status: "failed",
          error_message: err.message,
        } as any)
        .eq("id", job.id);
    }
  });

  return NextResponse.json({ job_id: job.id, started: true });
}

async function runDiscovery(jobId: string, clientLinkId: string, months: number) {
  const service = createServiceSupabase();

  // Load client + master COA
  const { data: client } = await service
    .from("client_links")
    .select("*")
    .eq("id", clientLinkId)
    .single();

  if (!client) throw new Error("Client not found");

  const accessToken = await getValidToken(clientLinkId, service as any);

  // 1. Pull transactions
  const transactions = await fetchRecentTransactions(client.qbo_realm_id, accessToken, months);

  await service
    .from("rule_discovery_jobs")
    .update({ transactions_pulled: transactions.length } as any)
    .eq("id", jobId);

  // 2. Group by vendor (min 2 transactions to be worth a rule)
  const vendorGroups = groupByVendor(transactions, { minTransactions: 2 });

  await service
    .from("rule_discovery_jobs")
    .update({ vendors_identified: vendorGroups.length } as any)
    .eq("id", jobId);

  // 3. Load master COA
  const { data: masterRows } = await service
    .from("master_coa")
    .select("*")
    .eq("jurisdiction", client.jurisdiction);

  const masterCOA = (masterRows || []).map((m: any) => ({
    account_name: m.account_name,
    parent_account_name: m.parent_account_name,
    is_parent: m.is_parent,
    qbo_account_type: m.qbo_account_type,
    qbo_account_subtype: m.qbo_account_subtype,
    section: m.section,
    notes: m.notes || "",
    is_required: m.is_required,
    tax_treatment: m.tax_treatment,
  }));

  // 4. Run AI analysis
  const analysis = await analyzeBankRules({
    clientName: client.client_name,
    jurisdiction: client.jurisdiction,
    vendorGroups,
    masterCOA,
  });

  // 5. Persist suggestions as pending bank_rules
  // Pull bookkeeper_id once (instead of N times inside the map)
  const { data: jobRow } = await service
    .from("rule_discovery_jobs")
    .select("bookkeeper_id")
    .eq("id", jobId)
    .single();
  const createdBy = (jobRow as any)?.bookkeeper_id || null;

  const rules = analysis.suggestions.map((s) => {
    const vendor = vendorGroups.find((v) => v.vendor_pattern === s.vendor_pattern);
    return {
      client_link_id: clientLinkId,
      discovery_job_id: jobId,
      vendor_pattern: s.vendor_pattern,
      match_type: s.suggested_match_type.toLowerCase(),
      target_account_name: s.target_account_name,
      status: "pending",
      ai_confidence: s.confidence,
      ai_reasoning: s.reasoning,
      requires_approval: s.requires_approval,
      sample_descriptions: vendor?.sample_descriptions || [],
      transaction_count: vendor?.transaction_count || 0,
      total_amount: vendor?.total_amount || 0,
      created_by: createdBy,
    };
  });

  if (rules.length > 0) {
    await service.from("bank_rules").insert(rules as any);
  }

  // 6. Mark job complete
  await service
    .from("rule_discovery_jobs")
    .update({
      status: "in_review",
      rules_suggested: rules.length,
      ai_completed_at: new Date().toISOString(),
    } as any)
    .eq("id", jobId);
}
