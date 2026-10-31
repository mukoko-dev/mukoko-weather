import { ExploreNotFound } from "@/components/layout/NotFoundView";

export default function CountryNotFound() {
  return (
    <ExploreNotFound
      title="Country not found"
      message="We don't have weather data for this country yet. Try browsing all supported countries."
    />
  );
}
