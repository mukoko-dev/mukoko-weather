import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { requireUser } from "@/lib/auth";
import { ProfileClient } from "./ProfileClient";

const BASE_URL = "https://weather.mukoko.com";

export const metadata: Metadata = {
  title: "Profile",
  description: "Manage your mukoko weather account and preferences.",
  alternates: {
    canonical: `${BASE_URL}/profile`,
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ProfilePage() {
  // Redirects anon users to sign-in, returns here after — same pattern as
  // /history, /aviation, /shamwari.
  const user = await requireUser("/profile");

  return (
    <>
      <Header />
      <main
        id="main-content"
        className="animate-fade-in mx-auto max-w-2xl px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8"
      >
        <h1 className="text-2xl font-bold text-text-primary mb-6">Profile</h1>
        <ProfileClient
          user={{
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            profilePictureUrl: user.profilePictureUrl,
          }}
        />
      </main>
      <Footer />
    </>
  );
}
