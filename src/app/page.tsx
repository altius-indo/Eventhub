import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/server/session";

export default async function Home() {
  redirect((await getSessionContext()) ? "/events" : "/login");
}
