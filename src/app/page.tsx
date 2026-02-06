import { redirect } from "next/navigation";

export default function Home() {
  // Default to Harare
  redirect("/harare");
}
