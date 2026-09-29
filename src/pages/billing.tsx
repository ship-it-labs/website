import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
      setError(err instanceof Error ? err.message : "Failed to load billing");
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
      setError(err instanceof Error ? err.message : "Failed to start checkout");
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
      setError(err instanceof Error ? err.message : "Failed to cancel subscription");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Payments are processed by Whop</p>
      </header>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      )}

      {subscription && (
        <Card>
          <CardHeader>
            <CardTitle>Current subscription</CardTitle>
            <CardDescription>
              {subscription.status} on {subscription.plan_id}
              {subscription.cancel_at_period_end ? " (cancels at period end)" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Period ends {new Date(subscription.current_period_end).toLocaleString()}
            </p>
            {subscription.status === "active" && (
              <Button
                variant="destructive"
                className="mt-3"
                disabled={busy === "cancel"}
                onClick={cancel}
              >
                Cancel subscription
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan) => (
          <Card key={plan.id}>
            <CardHeader>
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>
                {plan.price_cents === 0
                  ? "Free"
                  : `$${(plan.price_cents / 100).toFixed(2)} / month`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>{plan.runtime_hours_per_month} runtime hours / month</p>
              <p>{formatDuration(plan.max_runtime_hours * 3600)} max session</p>
              <p>{plan.max_ram_mb} MB RAM</p>
              <p>{plan.cpu} CPU</p>
              <p>{plan.build_timeout_seconds}s build timeout</p>
              {plan.price_cents > 0 && (
                <Button
                  className="mt-3 w-full"
                  disabled={busy === plan.id}
                  onClick={() => checkout(plan.id)}
                >
                  {busy === plan.id ? "Redirecting..." : "Subscribe"}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
