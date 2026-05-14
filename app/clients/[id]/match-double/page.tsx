import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { createServerSupabase } from "@/lib/supabase";
import { notFound } from "next/navigation";
import { DoubleMatcher } from "./double-matcher";

export default async function MatchDoublePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();

  const { data: clientLink } = await supabase
    .from("client_links")
    .select("*")
    .eq("id", id)
    .single();

  if (!clientLink) notFound();

  return (
    <AppShell>
      <TopBar
        title="Match Client to Double"
        subtitle="Connect this QuickBooks client to its Double HQ record"
      />
      <div className="px-8 py-6 max-w-3xl">
        <DoubleMatcher clientLink={clientLink} />
      </div>
    </AppShell>
  );
}
