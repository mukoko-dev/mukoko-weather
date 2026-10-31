import { ExploreNotFound } from "@/components/layout/NotFoundView";

export default function ProvinceNotFound() {
  return (
    <ExploreNotFound
      title="Province not found"
      message="We don't have weather data for this province yet. Try browsing the country or all supported countries."
    />
  );
}
