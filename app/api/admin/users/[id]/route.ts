import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * PATCH /api/admin/users/[id]
 *
 * Admin-only. Updates role or is_active for a user.
 * The role change trigger automatically writes to audit_log.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: targetUserId } = await context.params;

  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Verify admin role
  const { data: actor } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (actor?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  // Prevent self-demotion (can't remove your own admin)
  if (targetUserId === user.id) {
    return NextResponse.json(
      { error: "Cannot modify your own role. Ask another admin." },
      { status: 400 }
    );
  }

  const body = await request.json();
  const updates: Record<string, any> = {};

  if (body.role !== undefined) {
    if (!["admin", "lead", "bookkeeper", "viewer"].includes(body.role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    updates.role = body.role;
  }

  if (body.is_active !== undefined) {
    updates.is_active = !!body.is_active;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  // Use service role to bypass RLS for admin operations (audited by trigger)
  const service = createServiceSupabase();
  const { data, error } = await service
    .from("users")
    .update(updates)
    .eq("id", targetUserId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ user: data });
}
