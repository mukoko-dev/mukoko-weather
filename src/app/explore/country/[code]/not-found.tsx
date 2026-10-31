import {
  NotFoundView,
  EXPLORE_NOT_FOUND_ACTIONS,
} from "@/components/layout/NotFoundView";

export default function CountryNotFound() {
  return (
    <NotFoundView
      title="Country not found"
      message="We don't have weather data for this country yet. Try browsing all supported countries."
      actions={EXPLORE_NOT_FOUND_ACTIONS}
    />
  );
}
