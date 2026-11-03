import type { Metadata } from "next";
import { OfflineShell } from "./OfflineShell";

export const metadata: Metadata = {
  title: "Offline — mukoko weather",
  description:
    "You appear to be offline. Connect to the internet to get the latest weather data.",
  alternates: { canonical: "https://weather.mukoko.com/offline" },
};

/**
 * The service worker's offline shell. It is precached at install (fetched
 * without cookies, so it holds no visitor's name) and shown for any page the
 * worker cannot get and has no copy of. Everything it shows comes from the
 * device: see OfflineShell.
 */
export default function OfflinePage() {
  return <OfflineShell />;
}
