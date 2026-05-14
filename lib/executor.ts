/**
 * COA Cleanup Execution Engine — v2 (with live progress)
 *
 * Writes detailed progress to audit_log as it works.
 * Frontend polls /api/jobs/[id]/status which reads from audit_log.
 */

import { createServiceSupabase } from "./supabase";
import * as qbo from "./qbo";
import * as double from "./double";
import * as validate from "./qbo-validation";

type SupabaseClient = ReturnType<typeof createServiceSupabase>;

interface ExecutionContext {
  jobId: string;
  clientLinkId: string;
  realmId: string;
  accessToken: string;
  doubleClientId: string;
  bookkeeperId: string;
  supabase: SupabaseClient;
}

interface ExecutionStats {
  created: number;
  renamed: number;
  reclassified: number;
  inactivated: number;
  duration_seconds: number;
}

async function logProgress(
  ctx: ExecutionContext,
  eventType: string,
  message: string,
  payload: Record<string, unknown> = {}
) {
  await ctx.supabase.from("audit_log").insert({
    job_id: ctx.jobId,
    user_id: ctx.bookkeeperId,
    event_type: eventType,
    request_payload: { message, ...payload } as any,
    occurred_at: new Date().toISOString(),
  });
}

async function logActionResult(
  ctx: ExecutionContext,
  actionId: string | null,
  eventType: string,
  payload: unknown
) {
  await ctx.supabase.from("audit_log").insert({
    job_id: ctx.jobId,
    action_id: actionId,
    user_id: ctx.bookkeeperId,
    event_type: eventType,
    response_payload: payload as any,
    status_code: 200,
    occurred_at: new Date().toISOString(),
  });
}

async function markActionComplete(
  ctx: ExecutionContext,
  actionId: string,
  newQboId: string,
  response: unknown
) {
  await ctx.supabase
    .from("coa_actions")
    .update({
      executed: true,
      executed_at: new Date().toISOString(),
      new_qbo_account_id: newQboId,
      qbo_response: response as any,
    })
    .eq("id", actionId);
}

async function markActionFailed(ctx: ExecutionContext, actionId: string, errorMessage: string) {
  await ctx.supabase
    .from("coa_actions")
    .update({ executed: false, error_message: errorMessage })
    .eq("id", actionId);
}

/**
 * Convert a queued action into a `flag` so it surfaces in Lisa's review queue
 * without being attempted against QBO. Called by pre-flight validation when
 * we know an action would fail (system account, invalid enum, etc).
 */
async function flagAction(ctx: ExecutionContext, action: any, reason: string) {
  await ctx.supabase
    .from("coa_actions")
    .update({
      action: "flag",
      flagged_reason: reason,
      executed: false,
    })
    .eq("id", action.id);
  await logActionResult(ctx, action.id, "preflight_flagged", {
    name: action.current_name || action.new_name,
    reason,
  });
}

async function getBookkeeperName(ctx: ExecutionContext): Promise<string> {
  const { data } = await ctx.supabase
    .from("users")
    .select("full_name")
    .eq("id", ctx.bookkeeperId)
    .single();
  return data?.full_name || "IronBooks";
}

export async function executeJob(jobId: string): Promise<{
  success: boolean;
  errors: string[];
  stats: ExecutionStats;
}> {
  const supabase = createServiceSupabase();
  const startTime = Date.now();
  const errors: string[] = [];
  const stats: ExecutionStats = {
    created: 0, renamed: 0, reclassified: 0, inactivated: 0, duration_seconds: 0,
  };

  const { data: job, error: jobErr } = await supabase
    .from("coa_jobs")
    .select("*, client_links(*)")
    .eq("id", jobId)
    .single();
  if (jobErr || !job) throw new Error(`Job ${jobId} not found`);

  const clientLink = (job as any).client_links;
  if (!clientLink) throw new Error("Client link not found");

  await supabase.from("coa_jobs").update({
    status: "executing",
    execution_started_at: new Date().toISOString(),
  }).eq("id", jobId);

  const accessToken = await qbo.getValidToken(clientLink.id, supabase as any);

  const ctx: ExecutionContext = {
    jobId,
    clientLinkId: clientLink.id,
    realmId: clientLink.qbo_realm_id,
    accessToken,
    doubleClientId: clientLink.double_client_id,
    bookkeeperId: job.bookkeeper_id,
    supabase,
  };

  await logProgress(ctx, "job_start", `Starting cleanup for ${clientLink.client_name}`);

  const { data: actions } = await supabase
    .from("coa_actions").select("*").eq("job_id", jobId).order("sort_order");
  if (!actions) throw new Error("No actions found for job");

  try {
    // ============================================================
    // STAGE 0: Pre-flight validation
    // ============================================================
    // Before touching QBO, validate every action against known QBO rules.
    // Actions that are guaranteed to fail (system accounts, invalid enums,
    // rename-to-parent-name) get re-marked as `flag` with a reason, so they
    // surface in Lisa's review queue instead of polluting the error log.
    // Recoverable issues (wrong AccountType for known subtype) get auto-corrected.
    await logProgress(ctx, "stage_start", `Pre-flight validation of ${actions.length} actions`,
      { stage: "preflight", total: actions.length });

    // Fetch live QBO state once for name-collision checks.
    const liveAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
    const liveById = new Map(liveAccounts.map((a) => [a.Id, a]));

    // Fetch transaction counts per account. Critical for Rule 5: QBO blocks
    // inactivation of accounts with any historical transactions, even if the
    // current balance is zero. CurrentBalance alone is not enough.
    const txCounts = await qbo.fetchTransactionCountsForAllAccounts(
      ctx.realmId, ctx.accessToken
    );

    let flaggedCount = 0;
    let correctedCount = 0;

    for (const a of actions as any[]) {
      // -- Rule 1: System accounts cannot be modified via API.
      // If the action targets a known QBO system account (Uncategorized, etc),
      // flag it. Never attempt to rename/inactivate these.
      if (a.action !== "create" && a.current_name && validate.isSystemAccount(a.current_name)) {
        await flagAction(ctx, a, `System-protected QBO account "${a.current_name}" cannot be modified via API. Skipping.`);
        flaggedCount++;
        continue;
      }

      // -- Rule 2: Type/Subtype enum validity (creates only — renames don't change type)
      if (a.action === "create") {
        const v = validate.validateTypeSubtype(a.new_type, a.new_subtype);
        if (!v.ok) {
          const reason = v.suggestion
            ? `${v.reason}. Did you mean "${v.suggestion}"? Set new_subtype manually and retry.`
            : `${v.reason}. Account cannot be created.`;
          await flagAction(ctx, a, reason);
          flaggedCount++;
          continue;
        }
        if (v.correctedType && v.correctedType !== a.new_type) {
          // Auto-correct the AccountType to match the subtype's required type
          await ctx.supabase.from("coa_actions")
            .update({ new_type: v.correctedType })
            .eq("id", a.id);
          a.new_type = v.correctedType;
          correctedCount++;
          await logActionResult(ctx, a.id, "preflight_corrected", {
            field: "new_type",
            value: v.correctedType,
            reason: `Auto-corrected to match subtype "${a.new_subtype}"`,
          });
        }
      }

      // -- Rule 3: Rename target equals current parent's name (merge, not rename)
      if (a.action === "rename" && a.qbo_account_id && a.new_name) {
        const current = liveById.get(a.qbo_account_id);
        if (current?.SubAccount && current.ParentRef?.value) {
          const parent = liveById.get(current.ParentRef.value);
          if (parent && parent.Name.trim().toLowerCase() === a.new_name.trim().toLowerCase()) {
            await flagAction(ctx, a,
              `Rename target "${a.new_name}" equals the parent account's name. This looks like a merge, not a rename. Review manually.`
            );
            flaggedCount++;
            continue;
          }
        }
      }

      // -- Rule 4: Rename would cause a name collision
      if (a.action === "rename" && a.qbo_account_id && a.new_name) {
        const current = liveById.get(a.qbo_account_id);
        const parentId = current?.ParentRef?.value || null;
        if (validate.wouldCollide(a.new_name, liveAccounts, a.qbo_account_id, parentId)) {
          await flagAction(ctx, a,
            `Rename target "${a.new_name}" already exists in QBO at the same parent level. Pick a different name or use merge.`
          );
          flaggedCount++;
          continue;
        }
      }

      // -- Rule 5: Inactivate of an account with transaction history or non-zero balance.
      // QBO blocks API inactivation of accounts that:
      //   (a) have a non-zero current balance, OR
      //   (b) have any historical transactions (even if balance now nets to zero), OR
      //   (c) have active sub-accounts
      // The web UI lets users force-deactivate these with a warning popup; the API
      // does not. Detect proactively and flag — Lisa handles these manually in QBO.
      if (a.action === "delete" && a.qbo_account_id) {
        const current: any = liveById.get(a.qbo_account_id);
        if (current) {
          const balance = Number(current.CurrentBalance ?? 0);
          const balanceWithSubs = Number(current.CurrentBalanceWithSubAccounts ?? 0);
          let txCount = txCounts.get(a.qbo_account_id) ?? 0;

          // FALLBACK: If bulk tx count is 0 but the account might still have
          // transactions (TransactionList report has known reliability issues
          // on some sandbox/edge accounts), verify with a direct per-account
          // query before letting the delete through.
          // This is slower (1 extra API call per delete candidate) but is the
          // only 100% reliable way to catch the "has transactions" case.
          let hasTxFromDirectCheck = false;
          if (txCount === 0 && balance === 0 && balanceWithSubs === 0) {
            try {
              hasTxFromDirectCheck = await qbo.accountHasTransactions(
                ctx.realmId, ctx.accessToken, a.qbo_account_id
              );
            } catch {
              // ignore — proceed with txCount we already have
            }
          }

          // Active sub-accounts check
          const hasActiveChildren = liveAccounts.some(
            (other: any) =>
              other.ParentRef?.value === a.qbo_account_id &&
              other.Active !== false
          );

          if (
            balance !== 0 ||
            balanceWithSubs !== 0 ||
            txCount > 0 ||
            hasTxFromDirectCheck ||
            hasActiveChildren
          ) {
            const reasons: string[] = [];
            if (balance !== 0) reasons.push(`current balance ${balance.toFixed(2)}`);
            if (balanceWithSubs !== 0 && balanceWithSubs !== balance) {
              reasons.push(`balance-with-subs ${balanceWithSubs.toFixed(2)}`);
            }
            if (txCount > 0) reasons.push(`${txCount} historical transactions`);
            else if (hasTxFromDirectCheck) reasons.push(`has historical transactions (verified directly)`);
            if (hasActiveChildren) reasons.push(`active sub-accounts`);

            await flagAction(ctx, a,
              `Cannot inactivate "${current.Name}" via API: ${reasons.join(", ")}. QBO requires manual handling for accounts with activity — please reclassify transactions and zero the balance, then inactivate via QBO UI.`
            );
            flaggedCount++;
            continue;
          }
        }
      }
    }

    await logProgress(ctx, "stage_complete",
      `Pre-flight done. ${flaggedCount} flagged, ${correctedCount} auto-corrected.`,
      { stage: "preflight", flagged: flaggedCount, corrected: correctedCount });

    // Re-fetch actions so subsequent stages skip the just-flagged ones
    const { data: validatedActions } = await ctx.supabase
      .from("coa_actions").select("*").eq("job_id", jobId).order("sort_order");
    const liveActions = (validatedActions || actions) as any[];

    // STAGE 1: Create parents
    const parentCreations = liveActions.filter((a) => a.action === "create" && !a.new_parent_name);
    const parentIdMap = new Map<string, string>();

    if (parentCreations.length > 0) {
      await logProgress(ctx, "stage_start", `Creating ${parentCreations.length} parent accounts`,
        { stage: "create_parents", total: parentCreations.length });

      for (const action of parentCreations) {
        try {
          const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
            name: action.new_name!,
            accountType: action.new_type!,
            accountSubType: action.new_subtype!,
          });
          parentIdMap.set(action.new_name!, created.Id);
          await markActionComplete(ctx, action.id, created.Id, created);
          await logActionResult(ctx, action.id, "qbo_create_parent",
            { name: created.Name, id: created.Id });
          stats.created++;
        } catch (e: any) {
          errors.push(`Create parent "${action.new_name}" failed: ${e.message}`);
          await markActionFailed(ctx, action.id, e.message);
          await logProgress(ctx, "error", `Failed: ${action.new_name}`, { error: e.message });
        }
      }
      await logProgress(ctx, "stage_complete", `Parents created: ${stats.created}`, { stage: "create_parents" });
    }

    // STAGE 1.5: Auto-create any missing parent accounts referenced by child creations.
    // Claude's analysis sometimes assumes parents like "Vehicle Expenses" exist when they don't.
    // We look up the parent's QBO type from the master COA and create it on the fly.
    const childCreations = liveActions.filter((a) => a.action === "create" && a.new_parent_name);
    if (childCreations.length > 0) {
      const allAccountsCache = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const existingNames = new Set(allAccountsCache.map((a) => a.Name));

      // Distinct parent names referenced by children that aren't already known
      const neededParents = Array.from(
        new Set(
          childCreations
            .map((a) => a.new_parent_name!)
            .filter((p) => !parentIdMap.has(p) && !existingNames.has(p))
        )
      );

      if (neededParents.length > 0) {
        await logProgress(ctx, "stage_start", `Auto-creating ${neededParents.length} missing parent accounts`,
          { stage: "create_missing_parents", total: neededParents.length });

        // Fetch master COA rows for these parent names to get correct types/subtypes
        const { data: masterMatches } = await ctx.supabase
          .from("master_coa")
          .select("account_name, qbo_account_type, qbo_account_subtype, is_parent")
          .in("account_name", neededParents);

        const masterByName = new Map<string, any>(
          (masterMatches || []).map((m) => [m.account_name, m])
        );

        for (const parentName of neededParents) {
          try {
            const master = masterByName.get(parentName);
            // Fall back to "Expense / OtherMiscellaneousExpense" if not found in master
            // (rare — usually means Claude invented a parent name not in master COA)
            const accountType = master?.qbo_account_type || "Expense";
            const accountSubType = master?.qbo_account_subtype || "OtherMiscellaneousExpense";

            const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
              name: parentName,
              accountType,
              accountSubType,
            });
            parentIdMap.set(parentName, created.Id);
            await logActionResult(ctx, null, "qbo_create_missing_parent",
              { name: parentName, id: created.Id, type: accountType, subtype: accountSubType });
            stats.created++;
          } catch (e: any) {
            errors.push(`Auto-create missing parent "${parentName}" failed: ${e.message}`);
            await logProgress(ctx, "error", `Failed missing parent: ${parentName}`, { error: e.message });
          }
        }
        await logProgress(ctx, "stage_complete", `Missing parents created`, { stage: "create_missing_parents" });
      }
    }

    // STAGE 2: Create children
    if (childCreations.length > 0) {
      await logProgress(ctx, "stage_start", `Creating ${childCreations.length} sub-accounts`,
        { stage: "create_children", total: childCreations.length });

      for (const action of childCreations) {
        try {
          let parentId = parentIdMap.get(action.new_parent_name!);
          if (!parentId) {
            const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
            const existingParent = allAccounts.find((a) => a.Name === action.new_parent_name);
            if (!existingParent) throw new Error(`Parent "${action.new_parent_name}" not found`);
            parentId = existingParent.Id;
            parentIdMap.set(action.new_parent_name!, parentId);
          }

          // Defensive: QBO requires BOTH AccountType and AccountSubType.
          // If Claude's analysis didn't fill in subtype, fall back to master_coa.
          let accountType = action.new_type;
          let accountSubType = action.new_subtype;
          if (!accountType || !accountSubType) {
            const { data: master } = await ctx.supabase
              .from("master_coa")
              .select("qbo_account_type, qbo_account_subtype")
              .eq("account_name", action.new_name!)
              .maybeSingle();
            if (master) {
              accountType = accountType || master.qbo_account_type;
              accountSubType = accountSubType || master.qbo_account_subtype;
            }
          }
          if (!accountType || !accountSubType) {
            throw new Error(
              `Missing AccountType/AccountSubType for "${action.new_name}" and not found in master COA — skipping.`
            );
          }

          const created = await qbo.createAccount(ctx.realmId, ctx.accessToken, {
            name: action.new_name!,
            accountType,
            accountSubType,
            parentRefId: parentId,
            taxCodeRef: action.tax_code_ref || undefined,
          });

          await markActionComplete(ctx, action.id, created.Id, created);
          await logActionResult(ctx, action.id, "qbo_create_child",
            { name: created.Name, parent: action.new_parent_name, id: created.Id });
          stats.created++;
        } catch (e: any) {
          errors.push(`Create child "${action.new_name}" failed: ${e.message}`);
          await markActionFailed(ctx, action.id, e.message);
          await logProgress(ctx, "error", `Failed: ${action.new_name}`, { error: e.message });
        }
      }
      await logProgress(ctx, "stage_complete", `Children created`, { stage: "create_children" });
    }

    // STAGE 3: Rename
    const renames = liveActions.filter((a) => a.action === "rename");

    if (renames.length > 0) {
      await logProgress(ctx, "stage_start", `Renaming ${renames.length} accounts`,
        { stage: "rename", total: renames.length });

      const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const accountMap = new Map(allAccounts.map((a) => [a.Id, a]));

      for (const action of renames) {
        try {
          const current = accountMap.get(action.qbo_account_id!);
          if (!current) throw new Error("Account no longer exists in QBO");

          // Only send AccountSubType if it actually matches the existing AccountType
          // (otherwise QBO returns 2010 "invalid property"). The rename action should
          // primarily change the Name. Subtype changes are risky and we skip them.
          const renamed = await qbo.renameAccount(
            ctx.realmId, ctx.accessToken,
            action.qbo_account_id!, (current as any).SyncToken,
            action.new_name!,
            {
              // Pass the current account so renameAccount preserves SubAccount/ParentRef/AccountType.
              // Without this, QBO 2010s on sub-account renames.
              currentAccount: current as any,
              taxCodeRef: action.tax_code_ref || undefined,
            }
          );

          await markActionComplete(ctx, action.id, renamed.Id, renamed);
          await logActionResult(ctx, action.id, "qbo_rename",
            { from: action.current_name, to: renamed.Name });
          stats.renamed++;
        } catch (e: any) {
          errors.push(`Rename "${action.current_name}" failed: ${e.message}`);
          await markActionFailed(ctx, action.id, e.message);
          await logProgress(ctx, "error", `Failed: ${action.current_name}`, { error: e.message });
        }
      }
      await logProgress(ctx, "stage_complete", `Renames complete`, { stage: "rename" });
    }

    // STAGE 4: Inactivate
    const deletions = liveActions.filter((a) => a.action === "delete");

    if (deletions.length > 0) {
      await logProgress(ctx, "stage_start", `Inactivating ${deletions.length} accounts`,
        { stage: "inactivate", total: deletions.length });

      const allAccounts = await qbo.fetchAllAccounts(ctx.realmId, ctx.accessToken);
      const accountMap = new Map(allAccounts.map((a) => [a.Id, a]));

      for (const action of deletions) {
        try {
          const current = accountMap.get(action.qbo_account_id!);
          if (!current) continue;

          const inactive = await qbo.inactivateAccount(
            ctx.realmId, ctx.accessToken,
            action.qbo_account_id!, (current as any).SyncToken,
            current as any
          );

          await markActionComplete(ctx, action.id, inactive.Id, inactive);
          await logActionResult(ctx, action.id, "qbo_inactivate", { name: current.Name });
          stats.inactivated++;
        } catch (e: any) {
          errors.push(`Inactivate "${action.current_name}" failed: ${e.message}`);
          await markActionFailed(ctx, action.id, e.message);
        }
      }
      await logProgress(ctx, "stage_complete", `Inactivations complete`, { stage: "inactivate" });
    }

    // STAGE 5: Sync to Double
    await logProgress(ctx, "stage_start", "Syncing status to Double HQ", { stage: "double_sync" });
    try {
      const bookkeeperName = await getBookkeeperName(ctx);
      await double.postCleanupComplete(ctx.doubleClientId, {
        accountsRenamed: stats.renamed,
        accountsCreated: stats.created,
        accountsDeleted: stats.inactivated,
        transactionsReclassified: stats.reclassified,
        bookkeeperName,
        durationSeconds: Math.floor((Date.now() - startTime) / 1000),
      });
      await logProgress(ctx, "stage_complete", "Synced to Double", { stage: "double_sync" });
    } catch (e: any) {
      errors.push(`Double sync failed: ${e.message}`);
      await logProgress(ctx, "warning", `Double sync failed (non-fatal): ${e.message}`);
    }

    stats.duration_seconds = Math.floor((Date.now() - startTime) / 1000);

    await supabase.from("coa_jobs").update({
      status: "complete",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: stats.duration_seconds,
      error_message: errors.length > 0 ? errors.join("; ") : null,
    }).eq("id", jobId);

    await logProgress(ctx, "job_complete", `Job complete in ${stats.duration_seconds}s`,
      { stats, error_count: errors.length });

    return { success: errors.length === 0, errors, stats };
  } catch (fatalError: any) {
    await supabase.from("coa_jobs").update({
      status: "failed",
      execution_completed_at: new Date().toISOString(),
      execution_duration_seconds: Math.floor((Date.now() - startTime) / 1000),
      error_message: fatalError.message,
    }).eq("id", jobId);

    await logProgress(ctx, "job_failed", fatalError.message);
    throw fatalError;
  }
}
