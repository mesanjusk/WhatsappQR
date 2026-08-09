import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth/session";

export default async function HomePage() {
  const session = await getServerSession();
  redirect(session ? "/whatsapp" : "/login");
}
