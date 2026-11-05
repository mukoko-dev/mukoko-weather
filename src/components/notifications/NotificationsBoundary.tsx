"use client";

import { Component, type ReactNode } from "react";
import { reportErrorToAnalytics } from "@/lib/observability";

interface Props {
  children: ReactNode;
  /** Closes the centre (the store's `closeNotifications`). */
  onClose: () => void;
}

interface State {
  failed: boolean;
}

/**
 * Isolation for the notifications centre. The centre loads on demand, so
 * opening it can fail in two ways a person cannot do anything about: its code
 * did not arrive (offline, or a deploy replaced the file) or a render threw.
 * Either would reach the root error boundary and replace the whole page with
 * "Something went wrong"; here it becomes a small message under the bell with
 * a way out. Weather and every other part of the page keep working.
 *
 * It sits in the header's bell wrapper, so the message hangs where the popover
 * would. (A failed lazy import is remembered by React, so there is no retry
 * button: closing and opening again after a reload is the way.)
 */
export class NotificationsBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("Notifications centre error:", error);
    reportErrorToAnalytics(`render:notifications:${error.message}`, false);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        className="absolute right-0 top-full z-40 mt-2 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-[var(--gap-floor)] rounded-[var(--radius-card)] border border-border bg-surface-card p-[var(--inset-floor)] text-left shadow-lg"
      >
        <p className="gazelle">
          Notifications could not load. Check your connection, then try again.
        </p>
        <div>
          <button
            type="button"
            onClick={this.props.onClose}
            className="impala-sm"
          >
            Close
          </button>
        </div>
      </div>
    );
  }
}
