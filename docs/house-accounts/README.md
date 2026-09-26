# House Accounts v1 — saldo da casa (spec, 2026-07-19)

Prepaid per-restaurant credit with a bonus, loaded via Pix, redeemed inside
Racha's QR checkout. The capital-light steal from the inKind research
(plan §8.4-1): the venue is the issuer, funds settle DIRECT to the venue,
Racha never carries credit inventory or holds funds.

## Legal constraints (load-bearing — from the 2026-07-19 research)

These are not product preferences; they came out of CDC/BACEN analysis and
each maps to code:

1. **Principal never expires and is refundable.** Paid credit with short
   expiry or refund-at-discretion is void under CDC arts. 39/51 (12 months is
   the judicially blessed floor; we simply don't expire it at all).
2. **Bonus is a separate, clearly-labeled bucket** ("bônus promocional") and
   MAY expire — 30–90 days is shipped Brazilian practice (iFood wallet).
   Minimum validity accepted by config: **30 days**.
3. **Single venue only.** Credit valid across venues = e-money = prior BACEN
   payment-institution authorization (Res. 494/2025). Accounts are scoped to
   one `venue_id`; there is no cross-venue balance, ever.
4. **Venue is the issuer.** Load charges settle to the venue's
   `psp_recipient_id` (same no-platform-custody gate as check payments).
   Racha monetizes via SaaS (+ a split fee leg when a real PSP lands).
5. **Tips never come from credit** (Lei 13.419 + inKind practice): redeem
   carries no tip; tips stay on the Pix charge path.
6. **Mandatory UI copy** (wallet + load screens):
   - "Saldo pago: não expira e é reembolsável."
   - "Bônus promocional: expira em DD/MM/AAAA."
   - "Válido somente no {venue.name}."

## Domain model

- `house_accounts` — one per (venue, phone). Bearer credential is
  `account_token` (128-bit, like table QR tokens). Phone identifies the
  customer at the counter; always masked to `•••• 1234` in owner UI and logs.
- `house_account_events` — append-only ledger (audit source of truth):
  - `OPENED {}` 
  - `LOAD_CONFIRMED { txid, principalCents, bonusCents, bonusExpiresAt }`
  - `REDEEMED { txid, checkId, principalCents, bonusCents, lots: [{seq, useCents}] }`
  - `PRINCIPAL_REFUNDED { amountCents, settlement: 'manual' }`
- Operational balances (`principal_cents` + bonus lots with
  `remaining_cents`/`expires_at`) are maintained ONLY by the store's
  locked write paths (supabase: RPCs; memory: sync methods) and
  cross-checked against the reduced ledger by reconciliation. This is NOT
  the unmaintained-cache pattern: single writer path, reconciled.
- **Spend order:** bonus first (FIFO by earliest expiry), then principal.
- **Bonus expiry is lazy:** availability computes `expires_at > now`; no cron.
- `house_loads` — one row per load charge, keyed by PSP `txid`. Bonus is
  **quoted at charge time** (config changes between charge and webhook must
  not change what the customer was promised).
- Redeem writes a `payments` row with `method: 'house_account'`,
  `status: 'confirmado'`, `tip_cents: 0`, txid `ha_<hex>` — so panel totals
  and check reconciliation see it like any payment.

Venue config (columns on `venues`): `house_enabled` (default false),
`house_bonus_bp` (0–5000, default 1000 = 10%), `house_bonus_validity_days`
(30–365, default 90), `house_min_load_cents` (default 2000),
`house_max_load_cents` (default 50000).

## API contract

All responses use `{ success, data?, error? }`. Errors are PT-BR strings.

### Diner (public)

- `GET /api/house/config?t=<tableQrToken>`
  → `{ enabled, venueName, bonusBp, validityDays, minLoadCents, maxLoadCents }`
  (404 if token dead; `enabled:false` when venue hasn't enabled it)
- `POST /api/house/open` `{ token: <tableQrToken>, phone, name }`
  → `{ accountToken, venueName }` — creates the account.
  Phone: digits only after normalize, 10–13 digits. 409 if an account for
  that phone already exists at the venue (`"Conta já existe — peça seu link
  no balcão"`; the token is NEVER returned for an existing account).
- `GET /api/house/account?t=<accountToken>`
  → `{ venue: { name }, account: { name, phoneMasked, principalCents,
       bonusCents, totalCents, lots: [{ remainingCents, expiresAt }],
       ledger: [{ at, type, label, amountCents }] } }`
  `bonusCents`/`totalCents` are available (unexpired) amounts, computed now.
- `POST /api/house/load` `{ accountToken, amountCents }`
  → `{ txid, copiaECola, expiresAt, amountCents, bonusCents }`
  Validates min/max + enabled. `bonusCents = floor(amount * bonusBp / 10000)`.
- `POST /api/house/redeem` `{ accountToken, token: <tableQrToken>, amountCents }`
  → `{ txid, principalUsedCents, bonusUsedCents, check: <fresh check view> }`
  Guards: house enabled; account and check belong to the SAME venue; check
  open; `0 < amount ≤ min(available, remainingOnCheck)`. 409 on insufficient
  balance or races.

### Owner (Bearer token, venue-gated — same as /api/panel)

- `GET /api/house/admin?v=<venueId>`
  → `{ config, liability: { principalCents, bonusCents, accountCount },
       accounts: [{ id, name, phoneMasked, principalCents, bonusCents,
                    createdAt }] }`
- `PATCH /api/house/admin` `{ venueId, config: { enabled?, bonusBp?,
  validityDays?, minLoadCents?, maxLoadCents? } }` → `{ config }`
  (validates ranges above; validityDays < 30 rejected — legal floor)
- `POST /api/house/admin/rotate-token` `{ accountId }` → `{ accountToken }`
  (re-issue a customer's wallet link; old token dies)
- `POST /api/house/admin/refund` `{ accountId, amountCents }`
  → `{ principalCents }` — records PRINCIPAL_REFUNDED (settlement is manual
  in v1: the owner sends the Pix back; the ledger keeps the record).

### Webhook

Load confirmations arrive on the existing `POST /api/webhooks/psp` — the
handler falls back to house loads when a txid isn't a check charge.
Idempotent by txid. In demo mode `POST /api/dev/confirm { txid }` also
resolves load txids.

## Frontend

- **Wallet** `/carteira?t=<accountToken>`: balance card (principal vs bônus,
  expiry per lot), load flow (amount presets + Pix copia-e-cola + demo
  confirm button in demo mode), ledger list, legal copy block.
- **Check screen** (`/?t=`): "Pagar com saldo" appears when
  `localStorage['racha:house:<venueId>']` holds an account token and the
  venue has house enabled; shows available balance; amount defaults to the
  diner's share; deep-links to open/create wallet otherwise.
- **Admin** (`/admin`): "Saldo da casa" section per venue — enable toggle,
  bonus %, validity days, min/max, liability report, accounts list with
  rotate-link + refund actions.
- Warm Glass styling, PT-BR, centavos formatted `R$ 123,45`.

## Failure ordering (redeem) — hardened 2026-07-19 (adversarial review)

1. debit account (locked `house_redeem` RPC; **idempotent by txid** — the
   client sends an `idempotencyKey` per payment attempt, the txid derives
   from it, so a lost-response retry returns the prior debit instead of
   debiting twice) →
2. append check `PAYMENT_CONFIRMED` via `append_house_payment_guarded` —
   validated **inside the per-check advisory lock**: a raced second redeem
   that would overpay the check is refused (`excede o que falta pagar`),
   and the service **compensates** with `house_redeem_reverse`
   (`REDEEM_REVERSED` ledger event restores the exact principal + lot
   breakdown; the diner gets a 409 and keeps their money) →
3. upsert `payments` row (idempotent by txid; always attempted so a healed
   retry backfills a row lost to a crash).

Since 0043 (2026-09-26) step 2 also **requires the debit**. The append writes
only if a `REDEEMED` event exists with the same txid, the same check, and
principal + bonus equal to the amount. Otherwise it raises **RH009**, which
the classifier maps to 500 `house_debit_missing`, and nothing is written.

The service handles RH009 on its own path: it reverses the debit and answers
409 `house_debit_mismatch` ("your balance was not charged").
- If the reverse returns **RH010** (`house_redeem_unknown`, 0043: there was no
  debit), the answer is the same 409.
- If the reverse returns **RH007**, the payment already landed, and the result
  is success.
- If the reverse fails, the 500 `house_debit_missing` reaches the diner. That
  code is on the 5xx allowlist, and it tells them to go to the counter.
  Runbook: `docs/runbooks/saldo-debitado-sem-pagamento.md`.

Refusal order inside the append: idempotency → RH006 → RH002 → RH004 → RH009
→ RH003.

Crash permutations and their reconciliation findings (the canary RUNS on
every `GET /api/house/admin` — findings ride the response and criticals hit
stderr):
- crash after 1: `house_redeem_missing_payment_row` — check never paid →
  re-credit the customer. Since 0044 (2026-09-26) the **owner** does it with the
  "Devolver R$ X ao saldo" button on the wallet page:
  `POST /api/house/admin/recredit`. Rules:
  - The server accepts only the txid that reconciliation flags **right now**,
    and only **5 minutes** after the debit.
  - It uses the same `house_redeem_reverse`, with `reason: 'owner_recredit'`
    and `by` (the owner's user id).
  - Bonus from a lot that **expired** before the reversal comes back as a new
    lot (`reissue`) with the venue's validity, counted from the reversal. It
    never becomes principal.
- crash after 2: `house_redeem_missing_payment_row_paid` — check WAS paid →
  backfill the payments row; do **not** re-credit.
- reversed redeems are correctly absent from both and flag nothing.

## Decisions recorded

- **Refund keeps bonus.** `PRINCIPAL_REFUNDED` never touches bonus lots; a
  fully refunded load's bonus stays spendable until it expires. The refund
  response returns the account's still-active `bonusCents` and the admin UI
  warns the owner ("esta conta ainda tem R$ X de bônus ativo") so the
  load→refund→spend-bonus cycle is a visible, owner-accepted cost, not a
  silent one. Revoking bonus on refund is a future option (needs a
  BONUS_REVOKED event); v1 favors the customer.
- **Bonus expiry = end of day América/São_Paulo** on (confirm date +
  validity days), so the mandated "expira em DD/MM/AAAA" copy is exactly
  right — the customer gets slightly more than N×24h, never less than the
  displayed date promises.
- **Abuse bounds on /api/house/open**: 10 wallet creations / 10 min / IP
  (instance-local) + a hard 5000-accounts-per-venue cap in the service.
