# Racha

**O jeito mais rápido de fechar a conta.** QR na mesa → vê a conta → racha com os amigos →
paga com Pix → mesa livre. Pay-at-table para restaurantes brasileiros.

Sister product to [Seatable](https://seatable.one) (separate repo, brand, and infra; same
company and sales machine). Strategy & research:
`restaurant-ai-mcp/.claude/plans/2026-07-17-racha-pay-at-table-brazil/README.md`.
Operating rules: [CLAUDE.md](./CLAUDE.md) — the non-negotiables are law here.

## Status: v0 foundation

- [x] Money core: split engine (`api/_lib/checks/split-engine.js`) — integer centavos,
  exact largest-remainder splits (equal / by item / custom), serviço math
- [x] Check state machine (`api/_lib/checks/check-state.js`) — event-sourced, webhook-
  idempotent, overpay/late-payment never silently lost
- [x] Core schema (`supabase/migrations/0001_core.sql`) — venues, tables, checks,
  event log, payments; RLS service-role-only; append via RPC
- [x] Agent OS (`.claude/agents/`) — payments-architect, fintech-compliance (mandatory
  gate on money code), market-scout, builder
- [ ] PSP adapter (blocked on RFP: Pagar.me Customizado vs Zoop vs Iugu)
- [ ] POS adapters: manual (v0) + NCR Colibri (partner application pending)
- [ ] Diner PWA + restaurant panel (`apps/`)
- [ ] Supabase project + Vercel project + domain (after name/INPI check)

## Development

```bash
npm install
npm test        # split engine + state machine suites — must be green, always
```

## The gate

Pilot venues must reach **≥25% of checks migrating to Racha by week 8** or the product
parks. Everything in the roadmap is subordinate to that number.
