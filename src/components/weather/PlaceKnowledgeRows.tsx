"use client";

import { useEffect, useState } from "react";

import { InfoRow } from "@/components/ui/info-row";
import {
  fetchPlaceProfile,
  peekPlaceProfile,
  profileRows,
  type ProfileRow,
} from "@/lib/place-knowledge";

interface Props {
  slug: string;
  lat: number;
  lon: number;
  /** Labels the list for assistive technology (the card's heading id). */
  labelledBy: string;
}

/**
 * Stored place knowledge as extra rows in the "About {place}" card: climate
 * zone, what is typical this month, the next season and the crop calendar
 * (#277). Renders nothing while loading and when the profile is unavailable,
 * so the card never shows a gap or an error for optional context.
 */
export function PlaceKnowledgeRows({ slug, lat, lon, labelledBy }: Props) {
  const [rows, setRows] = useState<ProfileRow[]>(() =>
    profileRows(peekPlaceProfile(slug) ?? null),
  );

  useEffect(() => {
    // The request is shared and cached, so it is never aborted; a result for
    // a place the card has moved on from is simply ignored.
    let current = true;
    fetchPlaceProfile(slug, fetch, { lat, lon })
      .then((profile) => {
        if (current) setRows(profileRows(profile));
      })
      .catch(() => {
        // Optional context: a failed fetch shows nothing.
      });
    return () => {
      current = false;
    };
  }, [slug, lat, lon]);

  if (rows.length === 0) return null;
  return (
    <dl
      aria-labelledby={labelledBy}
      className="mt-2 space-y-2 border-t border-border pt-2 text-base"
      data-slot="place-knowledge"
    >
      {rows.map((row) => (
        <InfoRow key={row.label} label={row.label} value={row.value} />
      ))}
    </dl>
  );
}
