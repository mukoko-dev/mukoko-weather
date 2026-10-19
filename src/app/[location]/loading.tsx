import { DeviceLocationLoading } from "@/components/weather/DeviceSnapshot";

export default function LocationLoading() {
  // Paints this place's stored forecast at once when the device has one
  // (issue #269); otherwise the branded weather loading scene.
  return <DeviceLocationLoading />;
}
