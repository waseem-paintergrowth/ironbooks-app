import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * POST /api/admin/users/invite
 *
 * Admin-only. Sends a magic-link signup invitation and pre-provisions
 * the user in the users table with their role.
 *
 * Body: { email, full_name, role }
 */
export async function POST(request: Request) {
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

  const { email, full_name, role } = await request.json();

  if (!email || !full_name || !role) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (!["admin", "lead", "bookkeeper", "viewer"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const service = createServiceSupabase();

  // Check if user already exists
  const { data: existing } = await service
    .from("users")
    .select("id, email")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: "User already exists" }, { status: 400 });
  }

  // Send invite via Supabase Auth Admin API
  const { data: authResponse, error: inviteErr } = await (service as any).auth.admin.inviteUserByEmail(
    email,
    {
      data: { full_name, role },
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/auth/callback`,
    }
  );

  if (inviteErr || !authResponse?.user) {
    return NextResponse.json(
      { error: inviteErr?.message || "Invite failed" },
      { status: 500 }
    );
  }

  // Provision the user in our users table
  const { error: insertErr } = await service.from("users").insert({
    id: authResponse.user.id,
    email,
    full_name,
    role,
    is_active: true,
    invited_by: user.id,
    invited_at: new Date().toISOString(),
  } as any);

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Audit log
  await service.from("audit_log").insert({
    event_type: "user_invited",
    user_id: user.id,
    request_payload: { invited_email: email, role, full_name } as any,
  });

  return NextResponse.json({ success: true, user_id: authResponse.user.id });
}
