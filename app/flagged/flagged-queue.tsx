"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Flag, Check, Edit2, Trash2, ChevronDown, Building2, ArrowRight, Loader2, MapPin, User } from "lucide-react";
import Link from "next/link";

interface FlaggedAction {
  id: string;
  job_id: string;
  qbo_account_id: string | null;
  current_name: string | null;
  current_type: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  ai_suggested_target: string | null;
  flagged_reason: string | null;
  transaction_count: number | null;
}

interface FlaggedJob {
  job_id: string;
  client_name: string;
  jurisdiction: string;
  state_province: string;
  bookkeeper_name: string;
  created_at: string;
  actions: FlaggedAction[];
}

export function FlaggedQueue({ jobs: initialJobs }: { jobs: FlaggedJob[] }) {
  const router = useRouter();
  const [jobs, setJobs] = useState(initialJobs);

  async function resolveAction(
    actionId: string,
    jobId: string,
    newAction: "keep" | "rename" | "delete" | "flag",
    newName?: string,
    notes?: string
  ) {
    const res = await fetch(`/api/actions/${actionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: newAction, new_name: newName, notes }),
    });

    if (!res.ok) {
      const { error } = await res.json();
      alert(`Failed: ${error}`);
      return;
    }

    // Remove from local state
    setJobs((prev) =>
      prev
        .map((j) =>
          j.job_id === jobId
            ? { ...j, actions: j.actions.filter((a) => a.id !== actionId) }
            : j
        )
        .filter((j) => j.actions.length > 0)
    );

    router.refresh();
  }

  return (
    <div className="space-y-6">
      {jobs.map((job) => (
        <div key={job.job_id} className="rounded-xl bg-white border border-gray-200 overflow-hidden">
          {/* Job header */}
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between bg-yellow-50">
            <div className="flex items-center gap-3">
              <div className="rounded-lg flex items-center justify-center w-9 h-9 bg-yellow-100">
                <Flag size={16} className="text-yellow-600" />
              </div>
              <div>
                <h3 className="font-bold text-base text-navy">{job.client_name}</h3>
                <div className="text-xs text-ink-slate flex items-center gap-3 mt-0.5">
                  <span className="flex items-center gap-1">
                    <MapPin size={11} />
                    {job.jurisdiction} {job.state_province}
                  </span>
                  <span className="flex items-center gap-1">
                    <User size={11} />
                    {job.bookkeeper_name}
                  </span>
                  <span>{job.actions.length} flagged</span>
                </div>
              </div>
            </div>
            <Link
              href={`/jobs/${job.job_id}/review`}
              className="text-xs font-semibold text-teal hover:text-teal-dark flex items-center gap-1"
            >
              View full job <ArrowRight size={12} />
            </Link>
          </div>

          {/* Flagged actions */}
          <div className="divide-y divide-gray-100">
            {job.actions.map((action) => (
              <FlaggedRow
                key={action.id}
                action={action}
                onResolve={(newAction, newName, notes) =>
                  resolveAction(action.id, job.job_id, newAction, newName, notes)
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FlaggedRow({
  action,
  onResolve,
}: {
  action: FlaggedAction;
  onResolve: (newAction: "keep" | "rename" | "delete" | "flag", newName?: string, notes?: string) => Promise<void>;
}) {
  const [resolving, setResolving] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState(action.ai_suggested_target || "");

  const confidencePct = Math.round((action.ai_confidence || 0) * 100);
  const hasTransactions = (action.transaction_count || 0) > 0;

  async function handle(newAction: "keep" | "rename" | "delete" | "flag", newName?: string) {
    setResolving(true);
    await onResolve(newAction, newName);
    setResolving(false);
  }

  return (
    <div className="px-5 py-4">
      <div className="grid gap-4" style={{ gridTemplateColumns: "1fr auto" }}>
        <div>
          <div className="font-semibold text-sm text-navy mb-1">
            {action.current_name}
            {action.current_type && (
              <span className="ml-2 text-xs font-normal text-ink-slate">
                ({action.current_type})
              </span>
            )}
          </div>

          {action.flagged_reason && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-md px-3 py-2 mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-yellow-700 mb-0.5">
                Why flagged
              </p>
              <p className="text-sm text-navy">{action.flagged_reason}</p>
            </div>
          )}

          {action.ai_reasoning && (
            <p className="text-xs italic text-ink-slate mb-2">
              <strong className="not-italic font-semibold">AI Note:</strong> {action.ai_reasoning}
            </p>
          )}

          <div className="flex items-center gap-3 text-xs text-ink-slate">
            <span>
              AI Confidence: <span className="font-semibold text-navy">{confidencePct}%</span>
            </span>
            {action.ai_suggested_target && (
              <span>
                Suggested target: <span className="font-semibold text-navy">{action.ai_suggested_target}</span>
              </span>
            )}
            {hasTransactions && (
              <span className="text-orange-600 font-semibold">
                ⚠ has {action.transaction_count} transactions
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5 min-w-[150px]">
          <button
            disabled={resolving}
            onClick={() => handle("keep")}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-navy disabled:opacity-50"
          >
            <Check size={12} /> Keep as-is
          </button>

          {!showRename ? (
            <button
              disabled={resolving}
              onClick={() => setShowRename(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-teal-light hover:bg-teal/20 text-teal disabled:opacity-50"
            >
              <Edit2 size={12} /> Rename...
            </button>
          ) : (
            <div className="flex flex-col gap-1">
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder="Target account name"
                className="px-2 py-1 border border-gray-200 rounded text-xs outline-none focus:border-teal text-navy"
                autoFocus
              />
              <div className="flex gap-1">
                <button
                  disabled={resolving || !renameValue}
                  onClick={() => handle("rename", renameValue)}
                  className="flex-1 px-2 py-1 rounded text-xs font-semibold bg-teal text-white hover:bg-teal-dark disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  onClick={() => setShowRename(false)}
                  className="px-2 py-1 rounded text-xs font-semibold bg-gray-100 text-ink-slate hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <button
            disabled={resolving || hasTransactions}
            onClick={() => handle("delete")}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold bg-red-50 hover:bg-red-100 text-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            title={hasTransactions ? "Cannot delete - has transactions" : ""}
          >
            <Trash2 size={12} /> Delete
            {hasTransactions && <span className="ml-auto text-[10px]">blocked</span>}
          </button>

          {resolving && (
            <div className="flex items-center justify-center pt-1">
              <Loader2 size={14} className="animate-spin text-teal" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
