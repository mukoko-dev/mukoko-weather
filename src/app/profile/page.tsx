import type { Metadata } from "next";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";
import { requireUser } from "@/lib/auth";
import { getMyOrganizations, getMyProfile } from "@/lib/profile";
import { ProfileClient } from "./ProfileClient";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Profile",
  description: "Manage your mukoko weather profile, preferences, and settings.",
  alternates: {
    canonical: `${SITE_URL}/profile`,
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

  // identity.persons is the source of truth for profile data (Mukoko
  // ecosystem standard); both reads are fail-soft and fall back to the
  // session claims / an empty list.
  const profile = await getMyProfile(user);
  const organizations = await getMyOrganizations(profile.personId);

  return (
    <>
      <Header />
      <main
        id="main-content"
        className="animate-fade-in mx-auto w-full max-w-2xl px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8"
      >
        <ProfileClient
          user={{
            email: user.email,
            firstName: profile.givenName,
            lastName: profile.familyName,
            pictureUrl: profile.picture,
          }}
          organizations={organizations}
        />
      </main>
      <Footer />
    </>
  );
}
