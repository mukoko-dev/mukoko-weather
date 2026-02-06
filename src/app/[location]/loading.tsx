export default function LocationLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background" role="status" aria-label="Loading weather data">
      <div className="flex flex-col items-center gap-4">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-text-tertiary/20 border-t-primary" />
        <p className="text-sm text-text-secondary">Loading weather data...</p>
        <span className="sr-only">Loading weather data for this location</span>
      </div>
    </div>
  );
}
