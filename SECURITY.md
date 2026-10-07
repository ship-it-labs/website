# Security policy

## Reporting a vulnerability

Email **security@ship-it.dev** with what you found, the impact as you see it,
and steps to reproduce. Please give a reasonable window to fix before any
public disclosure. Do not probe other users' accounts, runtimes or builds to
prove a point — a report against your own account is enough.

Support questions go to support@ship-it.dev, not here.

## Secrets and rotation

Every secret below lives in the deployment environment (or the admin env
editor, which writes the same values), never in the repository. After rotating
any of them, restart the control plane so the new value takes effect.

| Secret | What breaks if it leaks | Rotation procedure |
| --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Full database bypass | Roll it in the Supabase dashboard, update the env, restart. Old key dies immediately. |
| `API_KEY_HASH_SECRET` | Lets an attacker test forged API keys offline | Set a new value and restart. **Warning:** existing key hashes were computed with the old secret, so every API key stops working and each user must create a new one. Announce this before rotating. |
| `WHOP_LIVE_API_KEY` / `WHOP_SANDBOX_API_KEY` | Billing API access | Roll in Whop, update the env, restart. |
| `PROD_WEBHOOK_SECRET` / `SANDBOX_WEBHOOK_SECRET` (`WHOP_WEBHOOK_SECRET` legacy) | Forged subscription events | Roll in Whop, update the env, restart. Webhooks signed with the old secret are rejected from that moment. |
| `GITHUB_TOKEN` | Build dispatch as the configured account | Regenerate on GitHub, update the env, restart. In-flight builds keep running; new dispatches use the new token. |
| `BUILD_REPORT_TOKEN` | Fake build logs attributed to CI | Pick a new random value, update both the control plane and the build workflow, restart. |
| `ORCHESTRATOR_SECRET` | Control of runtimes via the manager | Change it on the manager and the control plane together, restart both. A mismatch breaks all runtime calls, so rotate the pair atomically. |

If any secret above is ever committed to git, treat it as compromised: rotate
first, then purge the history.

## What is logged vs never logged

Logged (operational minimum): internal user ids, runtime/build/key/session row
ids, request ids, IP addresses on session rows and the account-deletion audit
line, device descriptions from the User-Agent header.

Never logged: passwords or password hashes, full API keys or session tokens
(only hashes are stored, and hashes never leave the server in responses),
payment details (Whop holds those; we keep only tier, status, renewal date and
the promo code on the subscription), private keys.

Emails and billing membership ids are censored at the logger
(`server/src/utils/logger.ts` redact list), because failure paths used to
print them. If you add a log line carrying user-supplied data, check it renders
no email, token, key or secret — the redact list is a safety net, not a permit.
