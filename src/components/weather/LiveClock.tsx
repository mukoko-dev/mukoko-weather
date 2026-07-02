"use client";

import { useEffect, useState } from "react";

function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Displays the user's current browser date and time, updated every minute. */
export function LiveClock() {
  // Initialise with the current time so first paint is correct (avoids
  // setState-in-effect). SSR may produce a different string than the client,
  // so suppressHydrationWarning is applied to the rendered element below.
  const [label, setLabel] = useState<string>(() => formatDateTime(new Date()));

  useEffect(() => {
    const id = setInterval(() => setLabel(formatDateTime(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <p
      className="text-sm text-text-tertiary"
      aria-label={`Current time: ${label}`}
      suppressHydrationWarning
    >
      {label}
    </p>
  );
}
