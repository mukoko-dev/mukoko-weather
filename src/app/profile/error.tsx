"use client";

import {
  RouteErrorBoundary,
  type RouteErrorProps,
} from "@/components/layout/RouteErrorBoundary";

export default function ProfileError(props: RouteErrorProps) {
  return (
    <RouteErrorBoundary
      {...props}
      title="Profile Unavailable"
      message="We couldn’t load your profile right now. Please try again."
      exhaustedMessage="Your profile is temporarily unavailable. Please try again later."
      source="profile"
      label="Profile page error"
    />
  );
}
