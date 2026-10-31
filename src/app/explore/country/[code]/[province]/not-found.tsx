import {
  NotFoundView,
  EXPLORE_NOT_FOUND_ACTIONS,
} from "@/components/layout/NotFoundView";

export default function ProvinceNotFound() {
  return (
    <NotFoundView
      title="Province not found"
      message="We don't have weather data for this province yet. Try browsing the country or all supported countries."
      actions={EXPLORE_NOT_FOUND_ACTIONS}
    />
  );
}
