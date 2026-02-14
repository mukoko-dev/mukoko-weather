"use client";

import { Component, type ReactNode } from "react";

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
 * If a Recharts chart throws during render (e.g. due to malformed data
 * or SVG rendering failures on low-memory mobile devices), this boundary
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
  }

  render() {
    if (this.state.hasError) {
      console.warn("[ChartErrorBoundary] showing fallback for:", this.props.name);
      return (
        <div
          role="alert"
          className="rounded-[var(--radius-card)] bg-surface-card p-4 text-center text-sm text-text-tertiary"
        >
          <p>Unable to display {this.props.name}.</p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 text-sm font-medium text-primary transition-colors hover:text-primary/80"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
