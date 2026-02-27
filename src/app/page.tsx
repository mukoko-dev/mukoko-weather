import type { Metadata } from "next";
import { HomeRedirect } from "./HomeRedirect";

const BASE_URL = "https://weather.mukoko.com";

/**
 * Home page canonical points to /harare so Google indexes the main location
 * page instead of this client-side redirect. Users still get the smart
 * geolocation-based redirect via HomeRedirect.
 */
export const metadata: Metadata = {
  alternates: {
    canonical: `${BASE_URL}/harare`,
  },
};

export default function Home() {
  return <HomeRedirect />;
}
