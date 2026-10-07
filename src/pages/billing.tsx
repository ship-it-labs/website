import { useCallback, useEffect, useState } from "react";
import { api, formatDuration } from "@/lib/api";
import {
  DashboardLayout,
  Panel,
  EmptyState,
} from "@/components/site/DashboardLayout";
import { Modal } from "@/components/site/Modal";
import { PromoNote } from "@/components/site/PromoBanner";
import { cn } from "@/lib/utils";

interface Plan {
  id: string;
  name: string;
  runtime_hours_per_month: number;
  max_runtime_hours: number;
  max_concurrent_runtimes: number;
  max_ram_mb: number;
  cpu: number;
  build_timeout_seconds: number;
  price_cents: number;
}

interface Subscription {
  id: string;
  plan_id: string;
  promo_code?: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean | number | null;
  manage_url?: string | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

type CardAction =
  | { kind: "current" }
  | { kind: "subscribe" }
  | { kind: "upgrade"; plan: Plan }
  | { kind: "downgrade"; plan: Plan };

/**
 * What each card offers depends on where the customer already stands, ranked
 * by price so future tiers slot in without code changes. The current tier
 * never shows a buy button — buying what you have is how double subscriptions
 * happen — and moving down always goes through an explicit choice rather than
 * an accidental checkout.
 */
function actionFor(
  plan: Plan,
  subscription: Subscription | null,
  currentPriceCents: number | null
): CardAction {
  const activePaid =
    subscription &&
    subscription.plan_id !== "free" &&
    (subscription.status === "active" ||
      subscription.status === "past_due" ||
      subscription.status === "trialing");

  if (!subscription || subscription.plan_id === "free" || subscription.status === "free") {
    if (plan.id === "free" || plan.price_cents === 0) return { kind: "current" };
    return { kind: "subscribe" };
  }

  const currentPrice =
    plan.id === subscription.plan_id ? plan.price_cents : null;
  if (currentPrice !== null) return { kind: "current" };

  if (!activePaid) {
    // Canceled, expired or otherwise dead: everything paid is a fresh start.
    if (plan.price_cents === 0) return { kind: "current" };
    return { kind: "subscribe" };
  }

  // Moving between live paid tiers: up costs money now, down costs nothing
  // until the period ends. The two paths differ — an upgrade opens a fresh
  // checkout (the webhook retires the old membership at period end, so paid
  // days are never taken twice), while a downgrade goes through an explicit
  // choice, because either path ends the current tier.
  if (plan.price_cents === 0) return { kind: "downgrade", plan };
  if (currentPriceCents !== null && plan.price_cents > currentPriceCents) {
    return { kind: "upgrade", plan };
  }
  return { kind: "downgrade", plan };
}

export function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [downgradeTarget, setDowngradeTarget] = useState<Plan | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api.get<{ plans: Plan[] }>("/api/v1/plans"),
        api.get<{ subscription: Subscription | null }>("/api/v1/billing/subscription"),
      ]);
      // Cheapest first, always: database row order is insertion order, which is
      // how Plus once displayed between Free and Ultra.
      setPlans([...p.plans].sort((a, b) => a.price_cents - b.price_cents));
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
      setConfirmCancel(false);
      setDowngradeTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel the subscription");
    } finally {
      setBusy(null);
    }
  }

  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const currentPlan =
    subscription && subscription.plan_id !== "free"
      ? (planById.get(subscription.plan_id) ?? null)
      : null;
  const endsAt = subscription?.current_period_end
    ? new Date(subscription.current_period_end)
    : null;
  const cancelScheduled = Boolean(subscription?.cancel_at_period_end);

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

      {subscription && currentPlan ? (
        <Panel title="Your plan" className="mb-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2.5">
                <span className="text-lg font-semibold text-white">
                  {currentPlan.name}
                </span>
                <span className="rounded-md bg-violet-500/20 px-1.5 py-0.5 text-[11px] font-medium text-violet-200">
                  Current plan
                </span>
                <StatusPill status={subscription.status} />
              </p>
              <p className="mt-2 text-sm text-zinc-400">
                {money(currentPlan.price_cents)} / month
                {endsAt && !Number.isNaN(endsAt.getTime()) && (
                  <>
                    {" · "}
                    {cancelScheduled ? "ends " : "renews "}
                    {endsAt.toLocaleDateString()}
                  </>
                )}
              </p>
              {!cancelScheduled && endsAt && !Number.isNaN(endsAt.getTime()) && (
                <p className="mt-1.5 text-sm text-zinc-300">
                  Next charge: {money(currentPlan.price_cents)} on{" "}
                  {endsAt.toLocaleDateString()}
                </p>
              )}
              {subscription.promo_code && (
                <p className="mt-1.5 text-xs text-emerald-300/90">
                  Discount applied with code {subscription.promo_code}.
                </p>
              )}
              {cancelScheduled && (
                <p className="mt-1.5 text-xs text-amber-300/90">
                  Cancels at the end of the period. Access continues until then,
                  and nothing further will be charged.
                </p>
              )}
              <p className="mt-1.5 text-xs text-zinc-600">
                Charges appear on your Whop receipt, which is the record that
                counts — this page mirrors it.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              {subscription.manage_url && (
                <a
                  href={subscription.manage_url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:text-white"
                >
                  Manage in Whop
                </a>
              )}
              {!cancelScheduled &&
                (subscription.status === "active" ||
                  subscription.status === "past_due" ||
                  subscription.status === "trialing") &&
                (confirmCancel ? (
                  <span className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy === "cancel"}
                      onClick={cancel}
                      className="rounded-xl bg-rose-500/90 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-rose-500 disabled:opacity-60"
                    >
                      {busy === "cancel" ? "Working…" : "Confirm cancellation"}
                    </button>
                    <button
                      type="button"
                      disabled={busy === "cancel"}
                      onClick={() => setConfirmCancel(false)}
                      className="rounded-xl px-3 py-2.5 text-sm text-zinc-400 transition-colors hover:text-zinc-200"
                    >
                      Keep plan
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmCancel(true)}
                    className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-5 py-2.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20"
                  >
                    Cancel subscription
                  </button>
                )
              )}
            </div>
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
        <>
          <PromoNote className="mb-6" />
          <div className="grid gap-5 md:grid-cols-3">
          {plans.map((plan) => {
            const action = actionFor(plan, subscription, currentPlan?.price_cents ?? null);
            return (
              <article
                key={plan.id}
                className={cn(
                  "glass h-full rounded-2xl p-7 transition-all duration-300 hover:-translate-y-1",
                  plan.id === "pro" && "border-violet-400/30 glow-violet"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-semibold text-white">{plan.name}</h2>
                  {action.kind === "current" && (
                    <span className="rounded-md bg-white/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-zinc-300">
                      Current plan
                    </span>
                  )}
                </div>
                <div className="mt-4 flex items-baseline gap-1">
                  <span className="font-serif text-4xl font-bold tracking-tight text-white">
                    {money(plan.price_cents)}
                  </span>
                  <span className="text-sm text-zinc-500">
                    {plan.price_cents === 0 ? "forever" : "/ month"}
                  </span>
                </div>
                <ul className="mt-6 space-y-2.5 text-sm text-zinc-400">
                  <li>{plan.runtime_hours_per_month} runtime hours / month</li>
                  <li>{formatDuration(plan.max_runtime_hours * 3600)} max session</li>
                  <li>
                    {plan.max_concurrent_runtimes} instance
                    {plan.max_concurrent_runtimes === 1 ? "" : "s"} at a time
                  </li>
                  {plan.id === "free" && (
                    <>
                      <li>{plan.max_ram_mb} MB memory</li>
                      <li>{plan.cpu} CPU</li>
                    </>
                  )}
                  <li>Builds use 16GB RAM and 4 vCPUs</li>
                  <li>{plan.build_timeout_seconds}s build timeout</li>
                </ul>

                {action.kind === "subscribe" && (
                  <button
                    type="button"
                    onClick={() => checkout(plan.id)}
                    disabled={busy === plan.id}
                    className="mt-7 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
                  >
                    {busy === plan.id ? "Working…" : "Subscribe"}
                  </button>
                )}
                {action.kind === "upgrade" && (
                  <>
                    <button
                      type="button"
                      onClick={() => checkout(action.plan.id)}
                      disabled={busy === action.plan.id}
                      className="mt-7 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02] disabled:opacity-60"
                    >
                      {busy === action.plan.id ? "Working…" : `Upgrade to ${action.plan.name}`}
                    </button>
                    <p className="mt-2 text-xs text-zinc-600">
                      Billed immediately in Whop. Your current plan runs until
                      the end of its period — paid days are never charged twice.
                    </p>
                  </>
                )}
                {action.kind === "downgrade" && (
                  <button
                    type="button"
                    onClick={() => setDowngradeTarget(action.plan)}
                    className="mt-7 w-full rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
                  >
                    {`Downgrade to ${action.plan.name}`}
                  </button>
                )}
              </article>
            );
          })}
          </div>
        </>
      )}

      {downgradeTarget && subscription && (
        <DowngradeDialog
          target={downgradeTarget}
          currentName={currentPlan?.name ?? subscription.plan_id}
          endsAt={endsAt}
          manageUrl={subscription.manage_url ?? null}
          busy={busy === "cancel"}
          onCancelNow={cancel}
          onClose={() => setDowngradeTarget(null)}
        />
      )}
    </DashboardLayout>
  );
}

function StatusPill({ status }: { status: string }) {
  // Billing states, not runtime states: kept separate from StatusDot on
  // purpose, because a green dot next to "past_due" would read as healthy.
  const tone =
    status === "active"
      ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
      : status === "canceled"
        ? "border-amber-400/30 bg-amber-500/10 text-amber-200"
        : status === "past_due"
          ? "border-rose-400/30 bg-rose-500/10 text-rose-200"
          : "border-white/10 bg-white/[0.04] text-zinc-400";

  return (
    <span
      className={`rounded-md border px-1.5 py-0.5 text-[11px] font-medium capitalize ${tone}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * Downgrading cannot move money — Whop's API has no server-side plan switch,
 * only customer-driven changes on their manage page. So the dialog offers the
 * two honest paths: switch now in Whop (immediate, Whop prorates), or cancel
 * now and let the paid period run out, then subscribe to the cheaper tier.
 */
function DowngradeDialog({
  target,
  currentName,
  endsAt,
  manageUrl,
  busy,
  onCancelNow,
  onClose,
}: {
  target: Plan;
  currentName: string;
  endsAt: Date | null;
  manageUrl: string | null;
  busy: boolean;
  onCancelNow: () => void;
  onClose: () => void;
}) {
  const endsLabel =
    endsAt && !Number.isNaN(endsAt.getTime())
      ? endsAt.toLocaleDateString()
      : "the end of the period";

  return (
    <Modal
      title={`Downgrade to ${target.name}`}
      description={`${money(target.price_cents)} / month after the switch`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {manageUrl && target.price_cents > 0 && (
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-5">
            <p className="text-sm font-medium text-white">Switch now</p>
            <p className="mt-1 text-sm text-zinc-400">
              Change plans inside Whop. It takes effect immediately and Whop
              handles the proration — {currentName} ends when {target.name}{" "}
              starts.
            </p>
            <a
              href={manageUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-block rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
            >
              Switch in Whop
            </a>
          </div>
        )}

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-5">
          <p className="text-sm font-medium text-white">
            {target.price_cents > 0 ? "Let it lapse" : "Just cancel"}
          </p>
          <p className="mt-1 text-sm text-zinc-400">
            Cancel {currentName} now. Nothing more is charged, access continues
            until {endsLabel}
            {target.price_cents > 0 &&
              `, and you subscribe to ${target.name} whenever after that`}
            .
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={onCancelNow}
            className="mt-4 rounded-xl border border-rose-400/30 bg-rose-500/10 px-5 py-2.5 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-60"
          >
            {busy ? "Working…" : `Cancel ${currentName}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
