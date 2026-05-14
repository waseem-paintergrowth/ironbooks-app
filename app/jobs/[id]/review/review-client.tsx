"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, Edit2, Trash2, Flag, Check, Loader2, Building2 } from "lucide-react";
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

type Action = Database["public"]["Tables"]["coa_actions"]["Row"];
type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

export function ReviewClient({
  jobId,
  clientLink,
  initialActions,
}: {
  jobId: string;
  clientLink: ClientLink;
  initialActions: Action[];
}) {
  const router = useRouter();
  const [actions, setActions] = useState(initialActions);
  const [filter, setFilter] = useState<"all" | "rename" | "delete" | "flag" | "keep" | "create">("all");
  const [executing, setExecuting] = useState(false);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const counts = {
    rename: actions.filter((a) => a.action === "rename").length,
    delete: actions.filter((a) => a.action === "delete").length,
    keep: actions.filter((a) => a.action === "keep").length,
    flag: actions.filter((a) => a.action === "flag").length,
    create: actions.filter((a) => a.action === "create").length,
  };

  const filtered = actions.filter((a) => filter === "all" || a.action === filter);

  async function updateAction(actionId: string, newAction: Action["action"], newTarget?: string) {
    setActions((prev) =>
      prev.map((a) =>
        a.id === actionId
          ? { ...a, action: newAction, new_name: newTarget ?? a.new_name, bookkeeper_override: true }
          : a
      )
    );

    await supabase
      .from("coa_actions")
      .update({
        action: newAction,
        new_name: newTarget,
        bookkeeper_override: true,
      })
      .eq("id", actionId);
  }

  async function approveAndExecute() {
    if (!confirm(`Execute this cleanup on ${clientLink.client_name}? This will modify QBO + Double.`)) {
      return;
    }
    setExecuting(true);

    let res: Response;
    let result: any = {};
    try {
      res = await fetch(`/api/jobs/${jobId}/execute`, { method: "POST" });
      result = await res.json().catch(() => ({}));
    } catch (err: any) {
      setExecuting(false);
      alert(`Network error while starting execution: ${err?.message || err}`);
      return;
    }

    setExecuting(false);

    // Execute endpoint returns { started: true, job_id } when kicked off successfully,
    // or { error: "..." } with non-2xx status on validation failures.
    if (res.ok && (result.started || result.message)) {
      router.push(`/jobs/${jobId}/execute`);
    } else {
      const msg =
        result.error ||
        (Array.isArray(result.errors) ? result.errors.join(", ") : null) ||
        `HTTP ${res.status} ${res.statusText}`;
      alert(`Could not start execution: ${msg}`);
    }
  }

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-5 gap-3 mb-5">
        {[
          { label: "Rename", value: counts.rename, color: "#2D7A75" },
          { label: "Delete", value: counts.delete, color: "#DC2626" },
          { label: "Keep", value: counts.keep, color: "#475569" },
          { label: "Flagged", value: counts.flag, color: "#F59E0B" },
          { label: "Create New", value: counts.create, color: "#10B981" },
        ].map((s) => (
          <div key={s.label} className="px-4 py-3 rounded-lg bg-white border border-gray-200">
            <div className="text-xs font-semibold uppercase tracking-wider mb-1 text-ink-slate">{s.label}</div>
            <div className="text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2 mb-4">
        {(["all", "rename", "delete", "flag", "keep", "create"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-sm font-semibold transition-colors capitalize ${
              filter === f
                ? "bg-navy text-white border border-navy"
                : "bg-white text-ink-slate border border-gray-200 hover:border-gray-300"
            }`}
          >
            {f} ({f === "all" ? actions.length : counts[f as keyof typeof counts]})
          </button>
        ))}
      </div>

      {/* Action table */}
      <div className="rounded-xl overflow-hidden bg-white border border-gray-200 mb-6">
        <div className="grid items-center px-5 py-3 text-xs font-bold uppercase tracking-wider bg-gray-50 text-ink-slate border-b border-gray-200"
             style={{ gridTemplateColumns: "1.5fr 1.6fr 1fr 1.2fr" }}>
          <div>Current Account</div>
          <div>AI Suggestion</div>
          <div>Confidence</div>
          <div>Action</div>
        </div>

        {filtered.map((action) => (
          <ActionRow key={action.id} action={action} onUpdate={updateAction} />
        ))}

        {filtered.length === 0 && (
          <p className="text-sm text-ink-slate py-12 text-center">No actions match this filter.</p>
        )}
      </div>

      <div className="flex justify-between items-center">
        <button
          onClick={() => router.back()}
          className="text-sm font-semibold text-ink-slate hover:text-navy"
        >
          ← Back to Dashboard
        </button>
        <div className="flex gap-3">
          <button className="text-sm font-semibold bg-white text-navy border border-gray-200 px-4 py-2 rounded-lg hover:bg-gray-50">
            Send to Lisa for Approval
          </button>
          <button
            onClick={approveAndExecute}
            disabled={executing}
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
          >
            {executing ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
            {executing ? "Executing..." : "Approve & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionRow({
  action,
  onUpdate,
}: {
  action: Action;
  onUpdate: (id: string, newAction: Action["action"], newTarget?: string) => void;
}) {
  const [showMenu, setShowMenu] = useState(false);

  const actionConfig = {
    keep: { color: "#475569", bg: "#F1F5F9", label: "Keep", icon: Check },
    rename: { color: "#2D7A75", bg: "#E8F2F0", label: "Rename", icon: Edit2 },
    delete: { color: "#DC2626", bg: "#FEE2E2", label: "Delete", icon: Trash2 },
    flag: { color: "#F59E0B", bg: "#FEF3C7", label: "Flag", icon: Flag },
    create: { color: "#10B981", bg: "#D1FAE5", label: "Create", icon: Building2 },
  };
  const cfg = actionConfig[action.action];
  const Icon = cfg.icon;

  const confidencePct = Math.round((action.ai_confidence || 0) * 100);

  return (
    <div
      className="grid items-center px-5 py-3.5 hover:bg-teal-lighter transition-colors border-b border-gray-100"
      style={{ gridTemplateColumns: "1.5fr 1.6fr 1fr 1.2fr" }}
    >
      <div>
        <div className="font-semibold text-sm text-navy">
          {action.current_name || (action.action === "create" ? `(New) ${action.new_name}` : "—")}
        </div>
        {action.current_type && (
          <div className="text-xs mt-0.5 text-ink-slate">{action.current_type}</div>
        )}
      </div>
      <div className="text-sm">
        {action.new_name && (
          <div className="flex items-center gap-2">
            <ArrowRight size={14} className="text-teal" />
            <span className="font-semibold text-navy">{action.new_name}</span>
          </div>
        )}
        {action.ai_reasoning && (
          <div className="text-xs mt-0.5 italic text-ink-slate">{action.ai_reasoning}</div>
        )}
      </div>
      <div>
        <span
          className="inline-flex px-2 py-0.5 rounded-md text-xs font-semibold"
          style={{
            color: confidencePct >= 90 ? "#10B981" : confidencePct >= 70 ? "#F59E0B" : "#DC2626",
            backgroundColor: confidencePct >= 90 ? "#D1FAE5" : confidencePct >= 70 ? "#FEF3C7" : "#FEE2E2",
          }}
        >
          {confidencePct}%
        </span>
      </div>
      <div className="relative">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-sm font-semibold transition-colors bg-white border border-gray-200 text-navy"
        >
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold"
            style={{ color: cfg.color, backgroundColor: cfg.bg }}
          >
            <Icon size={12} />
            {cfg.label}
          </span>
          <ChevronDown size={14} className="ml-auto text-ink-light" />
        </button>

        {showMenu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
            <div className="absolute right-0 top-full mt-1 rounded-lg shadow-lg z-20 overflow-hidden bg-white border border-gray-200 min-w-48">
              {(["keep", "rename", "delete", "flag"] as const).map((opt) => {
                const optCfg = actionConfig[opt];
                const OptIcon = optCfg.icon;
                const disabled = opt === "delete" && (action.transaction_count || 0) > 0;
                return (
                  <button
                    key={opt}
                    onClick={() => {
                      if (!disabled) {
                        onUpdate(action.id, opt, action.ai_suggested_target || action.new_name || undefined);
                        setShowMenu(false);
                      }
                    }}
                    disabled={disabled}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-teal-lighter disabled:opacity-40 disabled:cursor-not-allowed text-navy"
                  >
                    <OptIcon size={14} />
                    {optCfg.label}
                    {disabled && <span className="text-xs ml-auto text-ink-slate">has txns</span>}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
