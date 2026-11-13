import { CriticalStyles } from "@/components/layout/FirstScreenStyles";
import { DeviceLocationLoading } from "@/components/weather/DeviceSnapshot";

export default function LocationLoading() {
  // Paints this place's stored forecast at once when the device has one
  // (issue #269); otherwise the structural loading skeleton. The critical
  // styles are in the shell with it, ahead of the page that streams in after.
  return (
    <>
      <CriticalStyles />
      <DeviceLocationLoading />
    </>
  );
}
