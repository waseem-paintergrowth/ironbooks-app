import { createServerSupabase } from "@/lib/supabase";
import { getAuthStatus, listClients, clearTokenCache } from "@/lib/double";
import { NextResponse } from "next/server";

/**
 * GET /api/double/test
 *
 * Admin-only diagnostic endpoint. Verifies Double API connectivity in 4 steps:
 *   1. Check env vars are set
 *   2. Show token cache state
 *   3. Force a fresh OAuth token exchange
 *   4. Call /api/clients with limit=3 to verify the bearer token works
 *
 * Returns structured JSON with pass/fail per step. Does NOT expose actual
 * credentials or access tokens.
 *
 * Query params:
 *   - reset=1 → clears the token cache before testing (forces fresh OAuth)
 */
export async function GET(request: Request) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Admin-only
  const { data: profile } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const shouldReset = searchParams.get("reset") === "1";
  if (shouldReset) clearTokenCache();

  const result: {
    timestamp: string;
    overall: "pass" | "fail";
    steps: Array<{
      name: string;
      status: "pass" | "fail" | "skip";
      detail?: unknown;
      error?: string;
      durationMs?: number;
    }>;
  } = {
    timestamp: new Date().toISOString(),
    overall: "pass",
    steps: [],
  };

  // -------- Step 1: env vars --------
  const initialStatus = getAuthStatus();
  result.steps.push({
    name: "Environment variables",
    status: initialStatus.hasCredentials ? "pass" : "fail",
    detail: {
      hasCredentials: initialStatus.hasCredentials,
      baseUrl: initialStatus.baseUrl,
      tokenCached: initialStatus.cached,
      cacheExpiresInSec: initialStatus.expiresInSeconds,
    },
    error: initialStatus.hasCredentials
      ? undefined
      : "DOUBLE_CLIENT_ID and/or DOUBLE_CLIENT_SECRET not set",
  });

  if (!initialStatus.hasCredentials) {
    result.overall = "fail";
    return NextResponse.json(result);
  }

  // -------- Step 2: base URL sanity check --------
  result.steps.push({
    name: "Base URL",
    status: initialStatus.baseUrl === "https://api.doublehq.com" ? "pass" : "fail",
    detail: { configured: initialStatus.baseUrl, expected: "https://api.doublehq.com" },
    error:
      initialStatus.baseUrl !== "https://api.doublehq.com"
        ? `Base URL is "${initialStatus.baseUrl}". Update DOUBLE_BASE_URL env var to "https://api.doublehq.com" (no /v1 suffix).`
        : undefined,
  });

  if (initialStatus.baseUrl !== "https://api.doublehq.com") {
    result.overall = "fail";
    // Don't bail — still try the API call so user sees both failures at once
  }

  // -------- Step 3: OAuth token exchange (via first API call) --------
  // -------- Step 4: API call --------
  const apiCallStart = Date.now();
  try {
    const clients = await listClients({ limit: 3 });
    const elapsed = Date.now() - apiCallStart;

    // Verify token was obtained (it had to be, to get this far)
    const postCallStatus = getAuthStatus();
    result.steps.push({
      name: "OAuth token exchange",
      status: postCallStatus.cached ? "pass" : "fail",
      detail: {
        tokenCachedAfterCall: postCallStatus.cached,
        cacheExpiresInSec: postCallStatus.expiresInSeconds,
      },
    });

    result.steps.push({
      name: "API call: GET /api/clients?limit=3",
      status: "pass",
      durationMs: elapsed,
      detail: {
        clientCount: clients.length,
        sample: clients.map((c) => ({
          id: c.id,
          name: c.name,
          branchId: c.branchId,
          createdAt: c.createdAt,
        })),
      },
    });
  } catch (err: any) {
    const elapsed = Date.now() - apiCallStart;
    result.overall = "fail";

    // Determine which step failed based on error message
    const isAuthError =
      err.message?.includes("OAuth") ||
      err.message?.includes("token") ||
      err.message?.includes("401");

    if (isAuthError) {
      result.steps.push({
        name: "OAuth token exchange",
        status: "fail",
        durationMs: elapsed,
        error: err.message,
      });
      result.steps.push({
        name: "API call: GET /api/clients?limit=3",
        status: "skip",
      });
    } else {
      result.steps.push({
        name: "OAuth token exchange",
        status: "pass",
        detail: "Token obtained, but subsequent API call failed",
      });
      result.steps.push({
        name: "API call: GET /api/clients?limit=3",
        status: "fail",
        durationMs: elapsed,
        error: err.message,
      });
    }
  }

  // Overall pass only if all steps pass
  if (result.steps.some((s) => s.status === "fail")) {
    result.overall = "fail";
  }

  return NextResponse.json(result, { status: result.overall === "pass" ? 200 : 500 });
}
