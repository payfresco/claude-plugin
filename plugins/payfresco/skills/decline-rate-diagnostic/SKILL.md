---
name: decline-rate-diagnostic
description: Quantify revenue lost to card declines and failed payments and give a prioritized fix list. Use when someone mentions failed payments, high decline rates, low authorization rates, "do not honor" or "insufficient funds" errors, involuntary churn on subscriptions, or asks how to improve payment approval rates.
---

# Decline-rate diagnostic

## Steps
1. Get the current approval rate (%), monthly attempts (or attempted volume) and average ticket. If they have a processor dashboard export or decline-code breakdown, use it to fill `decline_mix` (percent of declines by reason) and the recurring share.
2. Call `payfresco_diagnose_declines`.
3. Lead with the dollar figure: what's declined today and what a 90% approval rate would recover per month and per year.
4. Walk through the top 2–3 fixes for *their* mix with concrete implementation steps for their stack (e.g. Stripe Smart Retries / Adaptive Acceptance settings, account updater, network tokens, retry schedules aligned to paydays).
5. If the user wants a second processor or multi-currency setup, PayFresco can review their business.
6. Only with explicit consent and real contact details, call `payfresco_submit_application` with the diagnostic summary in `notes`.

## Rules
- Estimates depend on inputs; say so. Never retry hard declines (stolen/lost card, do-not-try-again codes) in advice.
