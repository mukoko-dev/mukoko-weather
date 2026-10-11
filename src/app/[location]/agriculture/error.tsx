"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function AgricultureError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Agriculture Insights Unavailable"
      message="We couldn’t load the farm weather for this place right now. This is usually a temporary issue with our data providers."
      exhaustedMessage="Farm weather for this place is temporarily unavailable. Try again later or check the weather on the home page."
      source="agriculture"
      label="Agriculture page error"
      homeLabel="Go to the weather home page"
    />
  );
}
