import { supabase } from "../db/index.js";
import { logger } from "../utils/logger.js";

/**
 * A key's budget is a cap on the runtime minutes it may reserve.
 *
 * The minutes are reserved when a runtime starts, not billed afterwards: the
 * agent's usage worker knows how long a runtime actually ran, but not which
 * key asked for it, so charging the key after the fact would mean guessing.
 * Reserving up front is the honest model — the key may not start more than
 * its budget allows — and it is enforced before the start reaches an agent.
 *
 * The reservation is not refunded when a runtime stops early. Refunding would
 * need the real duration, which only the usage worker has, and the difference
 * is small next to the risk of a key quietly exceeding its budget.
 */

export async function reserveKeyMinutes(apiKeyId: string, minutes: number): Promise<void> {
  if (!apiKeyId || minutes <= 0) return;
  const { error } = await supabase.rpc("increment_api_key_reservation", {
    p_api_key_id: apiKeyId,
    p_minutes: Math.ceil(minutes),
  });
  if (error) {
    logger.error({ error, apiKeyId, minutes }, "Failed to reserve key budget");
  }
}
