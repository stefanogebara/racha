# Racha — pay-at-table for Brazil

**O jeito mais rápido de fechar a conta.** QR na mesa → vê a conta → racha → paga
(Pix-first) → mesa fecha. Separate product from Seatable (own repo, own Supabase, own
brand), same company and sales machine (Olímpia). Strategy doc:
`restaurant-ai-mcp/.Codex/plans/2026-07-17-racha-pay-at-table-brazil/README.md`.

## Non-negotiables (each one is paid-for knowledge)

1. **NO consumer-side fee. Ever.** sunday's 0.5–2% checkout fee → US class action
   (Hoke v. Sunday App, Jan/2026) + UK press backlash. We monetize the restaurant:
   SaaS + small margin on card volume + instant-settlement upsell. Pix near cost.
2. **Tips settle to the restaurant CNPJ, never to a waiter's personal Pix key.**
   Lei 13.419/2017 + STJ Tema 1102: the 10% is employee remuneration through payroll
   (INSS/IRRF/FGTS). We flag tip amounts in the split rules + reports; the restaurant
   distributes via folha. Direct-to-waiter settlement = labor/tax exposure for the client.
3. **The 10% serviço is OPTIONAL and removable in the UI** (CDC). Pre-selected is fine;
   locked is illegal.
4. **We never hold funds.** All money flows PSP → restaurant subaccount via split rules
   (Pagar.me/Zoop/Iugu class). No conta-bolsão. This keeps us outside BACEN Res. 494/2025
   licensing. Any fund-flow change needs a payments-counsel opinion FIRST.
5. **All money amounts are integer centavos.** No floats, anywhere, ever. Split math is
   exact: parts always sum to the total (largest-remainder allocation).
6. **Payment state is event-sourced.** Webhooks append events; state is derived; nothing
   overwrites history. Money bugs must be replayable.
7. **Conditional/atomic DB claims go through SQL RPCs with the error CHECKED** — never
   PostgREST `UPDATE` + `.or()` filters (Seatable incident 2026-07-14: PostgREST 42703s
   the construct; degrade-open masked 12 days of failure). Silent success is the enemy:
   a guard that "never fires" gets tested in prod, not trusted.
8. **Reconciliation from day 1.** Daily job: PSP ledger vs our splits, per venue, to the
   centavo. Drift ≥ R$0,01 alerts loudly. A red canary pages; it never just logs.
9. **Browser-only for diners. No app download, no login, no PANs through our servers**
   (PSP-hosted card fields → minimal PCI scope).
10. **LGPD:** payment processing under contract-execution basis; marketing use of dining
    data needs explicit opt-in; no cross-product data sharing with Seatable without consent
    (keeps the holding split clean).

## Architecture

- **Stack:** Vercel Node serverless (`api/*.js`, CommonJS, same idioms as Seatable),
  React/Vite diner PWA + restaurant panel (`apps/`), Supabase Postgres (own project,
  service-role only — RLS enabled, no anon policies).
- `api/_lib/checks/` — check model, **split-engine.js** (pure), **check-state.js**
  (event-sourced state machine). Pure modules: no I/O, exhaustively tested.
- `api/_lib/pos/` — POS adapters behind one interface: `manual` (v0 universal fallback),
  `colibri` (v0 target — NCR Colibri Cloud REST, ~30k venues, documented check read +
  payment write-back), `simphony` (v1).
- `api/_lib/pay/` — PSP adapter behind one interface (créate Pix cobrança w/ txid,
  card checkout link, split rules, webhook verify+parse). v0: `mock` + first real PSP
  after the RFP (Pagar.me Customizado vs Zoop vs Iugu).
- Library code in `_lib/` only; anything under `api/` not starting with `_` deploys as a
  function (Vercel NFT rules — never `require()` a sibling handler).

## Verification bar

- `npx jest` green before done — split engine and state machine have property-style tests
  (sum invariant, no negative parts, idempotent webhook application).
- Any code that moves money ships only after **fintech-compliance + security review**
  (agents in `.Codex/agents/`). No exceptions, no "it's a small change".
- Synthetic canary (staging, daily once deployed): open check → split 3 ways → 2 Pix +
  1 card → reconcile exact → close table. Any failure is a page.

## Working agreements

- **Bilingual UI (en + pt-BR), English by default.** Every user-facing string on
  the web platform goes through `apps/web/src/i18n.ts`, where both languages live
  on the same key — a pair, so a missing translation is a type error, not a
  Portuguese screen with one English sentence in it. The language switcher is in
  every footer and the choice is platform-wide.
  - **Venue content is never translated.** Table labels ("Mesa 7", "Varanda 2")
    and menu lines ("Picanha na chapa") are the restaurant's own words. UI chrome
    translates; the restaurant's sign does not.
  - **The server never sends display text for errors.** It sends a stable `code`
    plus raw centavos; the client translates and formats. A server that formats
    money has already picked a language for a reader it cannot see.
- Conventional commits. Small files by feature. Immutability by default.
- Adoption gate governs the roadmap: pilot venues must reach ≥25% of checks migrating by
  week 8 or the product parks. Don't build v1 features before the gate passes.
