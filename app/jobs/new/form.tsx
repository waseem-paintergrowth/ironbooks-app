"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { Search, ArrowRight, MapPin, CheckCircle2, Plus, Loader2 } from "lucide-react";
import type { Database } from "@/lib/database.types";

type ClientLink = Database["public"]["Tables"]["client_links"]["Row"];

export function NewJobForm({ clientLinks }: { clientLinks: ClientLink[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ClientLink | null>(null);
  const [creating, setCreating] = useState(false);

  // Auto-select client from URL deep link (?client=uuid)
  useEffect(() => {
    const clientId = searchParams.get("client");
    if (clientId && !selected) {
      const found = clientLinks.find((c) => c.id === clientId);
      if (found) setSelected(found);
    }
  }, [searchParams, clientLinks]);

  const supabase = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const filtered = clientLinks.filter((c) =>
    c.client_name.toLowerCase().includes(search.toLowerCase())
  );

  async function startJob() {
    if (!selected) return;
    setCreating(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      alert("Not signed in");
      setCreating(false);
      return;
    }

    const { data, error } = await supabase
      .from("coa_jobs")
      .insert({
        client_link_id: selected.id,
        bookkeeper_id: user.id,
        status: "draft",
      })
      .select()
      .single();

    if (error || !data) {
      alert(`Error creating job: ${error?.message}`);
      setCreating(false);
      return;
    }

    // Kick off analysis
    fetch(`/api/jobs/${data.id}/analyze`, { method: "POST" }).catch((e) =>
      console.error("Analysis kickoff failed:", e)
    );

    router.push(`/jobs/${data.id}/review`);
  }

  return (
    <div>
      {clientLinks.length === 0 && (
        <div className="rounded-xl p-6 mb-6 bg-yellow-50 border border-yellow-200">
          <h3 className="font-bold text-sm mb-2 text-navy">No clients connected yet</h3>
          <p className="text-sm text-ink-slate mb-4">
            Before you can run a cleanup, you need to connect a QuickBooks Online client.
          </p>
          <a
            href="/api/qbo/connect"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            <Plus size={16} />
            Connect QuickBooks Client
          </a>
        </div>
      )}

      <div className="rounded-xl bg-white border border-gray-200 mb-6">
        <div className="px-5 py-4 border-b border-gray-200">
          <h3 className="font-bold text-base text-navy">Select Client</h3>
          <p className="text-xs text-ink-slate">From your connected QBO + Double accounts</p>
        </div>

        <div className="p-5">
          <div className="relative mb-3">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-light" />
            <input
              type="text"
              placeholder="Search clients..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:border-teal text-navy"
            />
          </div>

          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {filtered.map((client) => {
              const isSelected = selected?.id === client.id;
              return (
                <button
                  key={client.id}
                  onClick={() => setSelected(client)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
                    isSelected ? "bg-teal-lighter border-2 border-teal" : "border-2 border-gray-100 hover:bg-teal-lighter"
                  }`}
                >
                  <div className="rounded-md flex items-center justify-center font-bold text-xs flex-shrink-0 w-8 h-8 bg-teal-light text-teal">
                    {client.client_name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm text-navy">{client.client_name}</div>
                    <div className="text-xs flex items-center gap-2 text-ink-slate">
                      <MapPin size={11} /> {client.jurisdiction} {client.state_province && `· ${client.state_province}`}
                    </div>
                  </div>
                  {isSelected && <CheckCircle2 size={18} className="text-teal" />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="text-sm text-ink-slate py-4 text-center">No clients match your search.</p>
            )}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button
          onClick={startJob}
          disabled={!selected || creating}
          className="inline-flex items-center gap-2 bg-teal hover:bg-teal-dark disabled:opacity-50 text-white text-sm font-semibold px-5 py-2.5 rounded-lg transition-colors"
        >
          {creating ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />}
          {creating ? "Starting..." : "Pull COA & Start Review"}
        </button>
      </div>
    </div>
  );
}
