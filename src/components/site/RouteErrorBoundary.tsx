import { Component, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

interface BoundaryState {
  failed: boolean;
}

/**
 * Route-level error boundary: a crash in one page shows a local fallback
 * instead of blanking the whole app. Remounting on pathname change (see
 * RouteRoot) clears the failure, so navigating away always recovers.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // Visible in devtools and log drains; the UI stays human-readable.
    console.error("Route crashed:", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
          <main className="mx-auto max-w-md px-6 pb-24 pt-36 text-center">
            <h1 className="font-serif text-3xl font-bold tracking-tight text-white">
              This page broke
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-zinc-400">
              Something in this view threw an error. The rest of the app is
              fine — pick somewhere to go and carry on.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => this.setState({ failed: false })}
                className="rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
              >
                Try again
              </button>
              <Link
                to="/"
                className="rounded-xl border border-white/15 px-5 py-2.5 text-sm text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
              >
                Home
              </Link>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Wraps the route tree and resets the boundary on every navigation, so an
 * error state can never trap the user on a dead page.
 */
export function RouteRoot({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <RouteErrorBoundary key={pathname}>{children}</RouteErrorBoundary>;
}
