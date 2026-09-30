import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import {
  DashboardLayout,
  Panel,
  EmptyState,
} from "@/components/site/DashboardLayout";
import { cn } from "@/lib/utils";

interface Plan {
  id: string;
  name: string;
  runtime_hours_per_month: number;
  max_runtime_hours: number;
  max_ram_mb: number;
  cpu: number;
  build_timeout_seconds: number;
  price_cents: number;
}

interface Subscription {
  id: string;
  plan_id: string;
  status: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

export function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api.get<{ plans: Plan[] }>("/api/v1/plans"),
        api.get<{ subscription: Subscription | null }>("/api/v1/billing/subscription"),
      ]);
      setPlans(p.plans);
      setSubscription(s.subscription);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load billing");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function checkout(planId: string) {
    setBusy(planId);
    setError(null);
    try {
      const result = await api.post<{ checkout_url: string }>("/api/v1/billing/checkout", {
        plan_id: planId,
      });
      window.location.href = result.checkout_url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      await api.post("/api/v1/billing/cancel");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the subscription");
    } finally {
      setBusy(null);
    }
  }

  return (
    <DashboardLayout
      title="Billing"
      subtitle="Plans are charged through Whop. Access continues until the end of the paid period."
    >
      {error && (
        <p className="mb-8 rounded-xl border border-rose-400/25 bg-rose-500/10 px-5 py-4 text-sm text-rose-200">
          {error}
        </p>
      )}

      {subscription ? (
        <Panel
          title="Current subscription"
          description={`Status: ${subscription.status} · cancels at period end: ${subscription.cancel_at_period_end ? "yes" : "no"}`}
          className="mb-8"
        >
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-zinc-300">
              Plan{" "}
              <span className="font-medium text-white">{subscription.plan_id}</span>
              {" · renews "}
              {new Date(subscription.current_period_end).toLocaleString()}
            </p>
            {subscription.status === "active" && (
              <button
                type="button"
                onClick={cancel}
                disabled={busy === "cancel"}
                className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-5 py-2.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-60"
              >
                {busy === "cancel" ? "Working…" : "Cancel"}
              </button>
            )}
          </div>
        </Panel>
      ) : (
        <p className="mb-8 text-sm text-zinc-500">
          No active subscription. Pick a plan below.
        </p>
      )}

      {plans.length === 0 ? (
        <Panel>
          <EmptyState>Plans could not be loaded. Try again in a moment.</EmptyState>
        </Panel>
      ) : (
        <div className="grid gap-5 md:grid-cols-3">
          {plans.map((plan) => (
            <article
              key={plan.id}
              className={cn(
                "glass h-full rounded-2xl p-7 transition-all duration-300 hover:-translate-y-1",
                plan.id === "pro" && "border-violet-400/30 glow-violet"
              )}
            >
              <h2 className="text-base font-semibold text-white">{plan.name}</h2>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="font-serif text-4xl font-bold tracking-tight text-white">
                  ${(plan.price_cents / 100).toFixed(0)}
                </span>
                <span className="text-sm text-zinc-500">
                  {plan.price_cents === 0 ? "forever" : "/ month"}
                </span>
              </div>
              <ul className="mt-6 space-y-2.5 text-sm text-zinc-400">
                <li>{plan.runtime_hours_per_month} runtime hours / month</li>
                <li>{formatDuration(plan.max_runtime_hours * 3600)} max session</li>
                <li>{plan.max_ram_mb} MB memory</li>
                <li>{plan.cpu} CPU</li>
                <li>{plan.build_timeout_seconds}s build timeout</li>
              </ul>
              {plan.price_cents > 0 && (
                <button
                  type="button"
                  onClick={() => checkout(plan.id)}
                  disabled={busy === plan.id}
                  className="mt-7 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
                >
                  {busy === plan.id ? "Working…" : "Subscribe"}
                </button>
              )}
            </article>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}
