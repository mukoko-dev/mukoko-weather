"use client";

import { InlineError } from "@/components/ui/inline-error";
import { Component, type ReactNode } from "react";
import { reportErrorToAnalytics } from "@/lib/observability";

interface Props {
  children: ReactNode;
  /** Accessible label describing what failed, e.g. "hourly forecast chart" */
  name: string;
}

interface State {
  hasError: boolean;
}

/**
 * Lightweight error boundary for chart components.
 *
 * If a Canvas chart throws during render (e.g. due to malformed data
 * or Canvas context failures on low-memory mobile devices), this boundary
 * catches the error and shows a compact fallback instead of crashing the
 * entire weather page.
 */
export class ChartErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(`Chart error (${this.props.name}):`, error);
    reportErrorToAnalytics(`render:${this.props.name}:${error.message}`, false);
  }

  render() {
    if (this.state.hasError) {
      console.warn(
        "[ChartErrorBoundary] showing fallback for:",
        this.props.name,
      );
      return (
        <InlineError
          tone="quiet"
          message={`Unable to display ${this.props.name}.`}
          onRetry={() => this.setState({ hasError: false })}
        />
      );
    }

    return this.props.children;
  }
}
