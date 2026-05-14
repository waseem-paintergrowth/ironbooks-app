"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle, Sparkles, GitMerge, ChevronRight } from "lucide-react";

interface ClientLink {
  id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string | null;
  qbo_realm_id: string;
  double_client_id: string | null;
  double_client_name: string | null;
}

interface QboAccount {
  id: string;
  name: string;
  fullyQualifiedName: string;
  accountType: string;
  accountSubType: string;
  currentBalance: number;
  classification: string;
}

type Workflow = "consolidation" | "scrub" | null;

export function NewReclassForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();

  // Step state
  const [workflow, setWorkflow] = useState<Workflow>(null);
  const [clientLinkId, setClientLinkId] = useState<string>("");
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsError, setAccountsError] = useState<string>("");

  // Form fields
  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [targetAccountId, setTargetAccountId] = useState<string>("");
  const [dateRangeStart, setDateRangeStart] = useState<string>("");
  const [dateRangeEnd, setDateRangeEnd] = useState<string>("");
  const [reason, setReason] = useState<string>("");

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>("");

  const selectedClient = clientLinks.find((c) => c.id === clientLinkId);
  const sourceAccount = accounts.find((a) => a.id === sourceAccountId);
  const targetAccount = accounts.find((a) => a.id === targetAccountId);

  // Default date range to current year
  useEffect(() => {
    const now = new Date();
    const yearStart = `${now.getUTCFullYear()}-01-01`;
    const today = now.toISOString().split("T")[0];
    setDateRangeStart(yearStart);
    setDateRangeEnd(today);
  }, []);

  // Load accounts when client changes
  useEffect(() => {
    if (!clientLinkId) {
      setAccounts([]);
      return;
    }
    setLoadingAccounts(true);
    setAccountsError("");
    setSourceAccountId("");
    setTargetAccountId("");
    fetch(`/api/clients/${clientLinkId}/qbo-accounts`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Failed to load accounts");
        return r.json();
      })
      .then((data) => setAccounts(data.accounts || []))
      .catch((e) => setAccountsError(e.message))
      .finally(() => setLoadingAccounts(false));
  }, [clientLinkId]);

  // Compute date range warning
  const daysDiff =
    dateRangeStart && dateRangeEnd
      ? Math.round(
          (new Date(dateRangeEnd).getTime() - new Date(dateRangeStart).getTime()) / 86400000
        )
      : 0;
  const dateRangeOverLimit = daysDiff > 366;

  const canSubmit =
    workflow &&
    clientLinkId &&
    sourceAccountId &&
    (workflow === "scrub" || targetAccountId) &&
    sourceAccountId !== targetAccountId &&
    dateRangeStart &&
    dateRangeEnd &&
    !dateRangeOverLimit &&
    reason.trim().length >= 5 &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit || !selectedClient || !sourceAccount) return;
    setSubmitting(true);
    setSubmitError("");

    try {
      const res = await fetch("/api/reclass/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_link_id: clientLinkId,
          workflow,
          source_account_id: sourceAccountId,
          source_account_name: sourceAccount.name,
          target_account_id: targetAccountId || undefined,
          target_account_name: targetAccount?.name || undefined,
          date_range_start: dateRangeStart,
          date_range_end: dateRangeEnd,
          jurisdiction: selectedClient.jurisdiction,
          state_province: selectedClient.state_province || "",
          reason: reason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start job");

      router.push(`/reclass/${data.job_id}/review`);
    } catch (e: any) {
      setSubmitError(e.message);
      setSubmitting(false);
    }
  }

  // ============== STEP 1: Choose workflow ==============
  if (!workflow) {
    return (
      <div className="space-y-4">
        <p className="text-ink-slate">Choose what kind of reclassification you want to run.</p>

        <button
          onClick={() => setWorkflow("consolidation")}
          className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-gray-100 hover:border-teal text-left transition-colors"
        >
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal-lighter flex items-center justify-center">
            <GitMerge className="text-teal" size={24} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-navy mb-1">Account Consolidation</div>
            <div className="text-sm text-ink-slate">
              Move all transactions from one account into another. Use when you want to merge "Supplies"
              into "Job Supplies" or eliminate a duplicate account.
            </div>
          </div>
          <ChevronRight className="text-ink-slate self-center" size={20} />
        </button>

        <button
          onClick={() => setWorkflow("scrub")}
          className="w-full flex items-start gap-4 p-6 bg-white rounded-2xl border-2 border-gray-100 hover:border-teal text-left transition-colors"
        >
          <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-teal-lighter flex items-center justify-center">
            <Sparkles className="text-teal" size={24} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-navy mb-1">AI Scrub</div>
            <div className="text-sm text-ink-slate">
              Pick a dumping-ground account (Uncategorized Expense, Ask My Accountant) and AI suggests
              the correct target per transaction. Three review tiers: auto-approve (95%+), needs review
              (70-94%), flagged (&lt;70%).
            </div>
          </div>
          <ChevronRight className="text-ink-slate self-center" size={20} />
        </button>
      </div>
    );
  }

  // ============== STEP 2: Setup form ==============
  return (
    <div className="space-y-6">
      <button
        onClick={() => {
          setWorkflow(null);
          setClientLinkId("");
        }}
        className="text-sm text-ink-slate hover:text-navy"
      >
        ← Change workflow
      </button>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-5">
        <div className="flex items-center gap-3">
          {workflow === "consolidation" ? (
            <>
              <GitMerge className="text-teal" size={24} />
              <h2 className="text-lg font-bold text-navy">Account Consolidation</h2>
            </>
          ) : (
            <>
              <Sparkles className="text-teal" size={24} />
              <h2 className="text-lg font-bold text-navy">AI Scrub</h2>
            </>
          )}
        </div>

        {/* Client picker */}
        <div>
          <label className="block text-sm font-semibold text-navy mb-2">Client</label>
          <select
            value={clientLinkId}
            onChange={(e) => setClientLinkId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
          >
            <option value="">Select a client...</option>
            {clientLinks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.client_name} ({c.jurisdiction})
              </option>
            ))}
          </select>
        </div>

        {/* Account loading state */}
        {clientLinkId && loadingAccounts && (
          <div className="flex items-center gap-2 text-sm text-ink-slate">
            <Loader2 className="animate-spin" size={16} />
            Loading chart of accounts from QBO...
          </div>
        )}
        {accountsError && (
          <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {accountsError}
          </div>
        )}

        {accounts.length > 0 && (
          <>
            {/* Source */}
            <div>
              <label className="block text-sm font-semibold text-navy mb-2">
                Source account {workflow === "scrub" ? "(the dumping ground to scrub)" : "(the account to move FROM)"}
              </label>
              <select
                value={sourceAccountId}
                onChange={(e) => setSourceAccountId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
              >
                <option value="">Select source account...</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullyQualifiedName} ({a.accountType})
                  </option>
                ))}
              </select>
            </div>

            {/* Target (consolidation only) */}
            {workflow === "consolidation" && (
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">
                  Target account (the account to move TO)
                </label>
                <select
                  value={targetAccountId}
                  onChange={(e) => setTargetAccountId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                >
                  <option value="">Select target account...</option>
                  {accounts
                    .filter((a) => a.id !== sourceAccountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.fullyQualifiedName} ({a.accountType})
                      </option>
                    ))}
                </select>
              </div>
            )}

            {/* Date range */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">Date range start</label>
                <input
                  type="date"
                  value={dateRangeStart}
                  onChange={(e) => setDateRangeStart(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-navy mb-2">Date range end</label>
                <input
                  type="date"
                  value={dateRangeEnd}
                  onChange={(e) => setDateRangeEnd(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
                />
              </div>
            </div>
            {dateRangeOverLimit && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                Date range is over 1 year ({daysDiff} days). Run multiple jobs for multi-year cleanup.
              </div>
            )}

            {/* Reason */}
            <div>
              <label className="block text-sm font-semibold text-navy mb-2">
                Reason (appears in QBO memo + audit log)
              </label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g., Q3 cleanup per client request"
                maxLength={200}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 focus:border-teal focus:outline-none"
              />
              <div className="mt-1 text-xs text-ink-slate">
                Min 5 chars. Will appear as: <code className="text-xs bg-gray-50 px-1.5 py-0.5 rounded">[IronBooks reclass YYYY-MM-DD by &#123;you&#125;: &#123;reason&#125;]</code>
              </div>
            </div>

            {/* Submit */}
            {submitError && (
              <div className="flex items-start gap-2 p-3 bg-red-50 text-red-800 rounded-lg text-sm">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                {submitError}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="w-full bg-teal hover:bg-teal-dark text-white font-semibold px-6 py-3 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="animate-spin" size={18} />}
              {submitting ? "Starting discovery..." : "Start Discovery"}
            </button>
            <p className="text-xs text-ink-slate text-center">
              Discovery will pull transactions, check reconciled status, check closed periods,
              {workflow === "scrub" && " run AI classification,"} and prepare a review queue.
              You'll review before anything is changed in QBO.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
