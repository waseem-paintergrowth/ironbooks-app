import { listClients, listAllClients, suggestMatch } from "@/lib/double";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { NextResponse } from "next/server";

/**
 * GET /api/double/clients?qbo_realm=...&search=...&all=1
 *
 * Lists Double clients with optional smart-match suggestion against a QBO client.
 *
 * Behavior:
 *  - If `search` provided → calls Double with name filter (server-side partial match), max 100
 *  - If `all=1` → paginates through ALL clients (slower; for small practices only)
 *  - Default → first 100 clients (Double API hard max per page)
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const qboRealm = searchParams.get("qbo_realm");
  const search = searchParams.get("search") || undefined;
  const fetchAll = searchParams.get("all") === "1";

  try {
    const clients = fetchAll
      ? await listAllClients()
      : await listClients({ name: search, limit: 100 });

    let suggestion = null;
    if (qboRealm) {
      const service = createServiceSupabase();
      const { data: link } = await service
        .from("client_links")
        .select("client_name, client_email, state_province")
        .eq("qbo_realm_id", qboRealm)
        .single();

      if (link) {
        suggestion = suggestMatch(
          {
            name: link.client_name,
            email: link.client_email || undefined,
            state: link.state_province || undefined,
          },
          clients
        );
      }
    }

    return NextResponse.json({ clients, suggestion });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
