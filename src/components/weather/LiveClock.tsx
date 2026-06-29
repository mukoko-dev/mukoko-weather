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
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    setLabel(formatDateTime(new Date()));
    const id = setInterval(() => setLabel(formatDateTime(new Date())), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!label) return null;

  return (
    <p className="mx-auto max-w-7xl px-4 pt-1 text-sm text-text-tertiary sm:px-6 md:px-8" aria-label={`Current time: ${label}`}>
      {label}
    </p>
  );
}
