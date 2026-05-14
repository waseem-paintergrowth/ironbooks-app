import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/master-coa/[id]
 *
 * Update an account. Lead/admin only (enforced by RLS).
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();

  // Strip fields that should never be edited directly
  delete body.id;
  delete body.created_at;
  delete body.updated_at;

  const { data, error } = await supabase
    .from("master_coa")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ account: data });
}

/**
 * DELETE /api/master-coa/[id]
 *
 * Soft-block deletion if account is in active use.
 * Lead/admin only.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Check usage
  const { data: usage } = await supabase
    .from("master_coa_usage")
    .select("times_used_in_cleanups, times_used_in_rules")
    .eq("id", id)
    .single();

  const totalUses = (usage?.times_used_in_cleanups || 0) + (usage?.times_used_in_rules || 0);
  if (totalUses > 0) {
    return NextResponse.json(
      {
        error: `This account is referenced in ${usage?.times_used_in_cleanups} cleanups and ${usage?.times_used_in_rules} rules. Mark it not required instead, or rename it.`,
      },
      { status: 400 }
    );
  }

  // Check if it's a parent with children
  const { data: account } = await supabase
    .from("master_coa")
    .select("account_name, is_parent, jurisdiction")
    .eq("id", id)
    .single();

  if (account?.is_parent) {
    const { count } = await supabase
      .from("master_coa")
      .select("*", { count: "exact", head: true })
      .eq("parent_account_name", account.account_name)
      .eq("jurisdiction", account.jurisdiction);

    if (count && count > 0) {
      return NextResponse.json(
        { error: `Cannot delete parent with ${count} children. Delete or reparent children first.` },
        { status: 400 }
      );
    }
  }

  const { error } = await supabase.from("master_coa").delete().eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
