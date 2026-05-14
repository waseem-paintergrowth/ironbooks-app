import { createServerSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/audit
 *
 * Searchable audit log. Filters: user_id, client_link_id, job_id, event_type, since, until.
 * Returns last 500 events by default.
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Allow admin OR lead to view audit log (Lisa needs to review work too)
  const { data: actor } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!actor || !["admin", "lead"].includes(actor.role)) {
    return NextResponse.json({ error: "Admin or Lead only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("user_id");
  const clientLinkId = searchParams.get("client_link_id");
  const jobId = searchParams.get("job_id");
  const eventType = searchParams.get("event_type");
  const since = searchParams.get("since");
  const until = searchParams.get("until");
  const limit = parseInt(searchParams.get("limit") || "200");

  let query = supabase
    .from("recent_activity_feed")
    .select("*")
    .order("occurred_at", { ascending: false })
    .limit(Math.min(limit, 500));

  if (userId) query = query.eq("user_id", userId);
  if (clientLinkId) query = query.eq("client_link_id", clientLinkId);
  if (jobId) query = query.eq("job_id", jobId);
  if (eventType) query = query.eq("event_type", eventType);
  if (since) query = query.gte("occurred_at", since);
  if (until) query = query.lte("occurred_at", until);

  const { data: events, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ events: events || [], count: events?.length || 0 });
}
