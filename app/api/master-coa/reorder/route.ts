import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/master-coa/reorder
 *
 * Bulk-update sort_order for multiple accounts.
 * Body: { updates: [{ id, sort_order }] }
 */
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { updates } = await request.json();
  if (!Array.isArray(updates)) {
    return NextResponse.json({ error: "updates must be an array" }, { status: 400 });
  }

  // Update each row in parallel - RLS enforces lead/admin
  const results = await Promise.all(
    updates.map((u: { id: string; sort_order: number }) =>
      supabase.from("master_coa").update({ sort_order: u.sort_order }).eq("id", u.id)
    )
  );

  const errors = results.filter((r) => r.error).map((r) => r.error?.message);
  if (errors.length > 0) {
    return NextResponse.json(
      { error: `Failed updates: ${errors.join(", ")}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, updated: updates.length });
}
