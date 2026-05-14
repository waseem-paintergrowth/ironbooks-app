import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/rules/[id]
 *
 * Body: { status?: 'approved'|'rejected'|'pending', target_account_name?: string, vendor_pattern?: string }
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
  const updates: Record<string, any> = {};

  if (body.status !== undefined) updates.status = body.status;
  if (body.target_account_name !== undefined) updates.target_account_name = body.target_account_name;
  if (body.vendor_pattern !== undefined) updates.vendor_pattern = body.vendor_pattern;
  if (body.match_type !== undefined) updates.match_type = body.match_type;

  const { data, error } = await supabase
    .from("bank_rules")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rule: data });
}
