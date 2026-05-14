import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase";

/**
 * Admin layout - gates ALL /admin/* routes to admin role only.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login");

  const { data: profile } = await supabase
    .from("users")
    .select("role, is_active")
    .eq("id", user.id)
    .single<{ role: string; is_active: boolean | null }>();

  if (!profile || !profile.is_active || profile.role !== "admin") {
    redirect("/dashboard?error=admin_required");
  }

  return <>{children}</>;
}
