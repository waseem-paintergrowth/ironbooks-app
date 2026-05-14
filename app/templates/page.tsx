import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { MasterCOAEditor } from "./editor";

export default async function MasterCOAPage() {
  const supabase = await createServerSupabase();

  // Check role for read-only vs editable
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("role").eq("id", user.id).single()
    : { data: null };

  const canEdit = profile && ["admin", "lead"].includes(profile.role);

  // Pre-fetch both jurisdictions for fast tab switching
  const [usData, caData, usageData] = await Promise.all([
    supabase.from("master_coa").select("*").eq("jurisdiction", "US").order("sort_order"),
    supabase.from("master_coa").select("*").eq("jurisdiction", "CA").order("sort_order"),
    supabase.from("master_coa_usage").select("*"),
  ]);

  const usageMap = new Map((usageData.data || []).map((u: any) => [u.id, u]));

  const usAccounts = (usData.data || []).map((a) => ({
    ...a,
    usage: usageMap.get(a.id) || { times_used_in_cleanups: 0, times_used_in_rules: 0 },
  }));

  const caAccounts = (caData.data || []).map((a) => ({
    ...a,
    usage: usageMap.get(a.id) || { times_used_in_cleanups: 0, times_used_in_rules: 0 },
  }));

  return (
    <AppShell>
      <TopBar
        title="Master COA"
        subtitle={
          canEdit
            ? "Standard chart of accounts — edit, add, reorder"
            : "Standard chart of accounts (read-only)"
        }
      />
      <div className="px-8 py-6">
        <MasterCOAEditor
          initialUS={usAccounts}
          initialCA={caAccounts}
          canEdit={!!canEdit}
        />
      </div>
    </AppShell>
  );
}
