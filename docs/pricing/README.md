# How Racha charges: the plan, in simple terms

**DECIDED by Stefano on 2026-09-26.** The landing page shows only the pilot
part (free, the customer never pays); the R$ 89/month goes on the site after
the payment provider gives us its real Pix price.

*Written 2026-09-26. The numbers come from public price pages, checked that day.
Sources and details are at the end. This is a proposal: the final prices depend
on what the payment provider (Pagar.me or Zoop) actually offers us.*

## The short version

- **The customer at the table never pays us anything.** Not a fee, not a cent.
  (sunday, a competitor, charged diners a hidden fee and got sued in the US
  for it.)
- **During the pilot, the restaurant pays us nothing either.** It pays only
  what the payment provider charges, passed through at cost.
- **After the pilot works** (restaurants moving ≥25% of their bills to Racha
  by week 8), the restaurant pays:
  - **about R$ 89 a month**, a flat fee;
  - **Pix: no extra from us.** Just the provider's cost.
  - **Card: the provider's cost + a small margin (0.3–0.5%)**, never more than
    the restaurant already pays at its own card machine.
  - **Optional: "get your card money today" for an extra fee.** Card money
    normally arrives in 30 days.

## Why a monthly fee and not a % of every payment

1. **Restaurants hate commissions.** Delivery apps take about 28.7% of every
   order, and restaurants keep only 6–9% of their sales as profit. That's why
   the tools that sell well in Brazil (Goomer, Anota AI, Consumer) all
   advertise "sem comissão": a flat monthly price.
2. **On cards there's almost no room.** At their own card machine,
   restaurants already pay about 1.6–3.5% on credit and 0.75–1.9% on debit.
   The online payment providers charge *more* than that at list price
   (Pagar.me: 4.19% on credit). So we can only add a thin margin, and only if
   we negotiate a good price.
3. **R$ 89 is below what they pay for everything else.** A restaurant's whole
   cash-register system (PDV) costs R$ 60–300 a month. A "pay at the table"
   add-on can't cost more than the main system.

## The one number that decides whether this works: the price of each Pix

When a table **splits** the bill, one bill becomes several payments.

> A R$ 150 bill split 3 ways = **3 Pix payments of R$ 50**.
> If the provider charges a fixed R$ 1.99 per Pix (Asaas's list price), that's
> R$ 5.97, **about 4% of the bill**.
> At the restaurant's own card machine, Pix costs **0%**.

The Central Bank's own cost for a Pix is about a tenth of a centavo. So in the
negotiation we need **each Pix to cost at most R$ 0.10–0.30**, or a small %
with no fixed part. Otherwise Racha is more expensive than the machine, and no
restaurant switches. This is requirement #1 in the provider negotiation
(`docs/rfp/README.md`).

## What competitors charge (for reference)

| Who | How they charge | How much |
|---|---|---|
| iFood "Na Mesa" (shut down in 2024) | % of each payment | 1.99% |
| TheFork PAY (Europe only) | nothing to the restaurant | 0% |
| qlub | % + subscription | ~1.5–3% (not confirmed; their Brazilian site is down) |
| sunday (US) | monthly **+ a fee on diners** | US$ 199–299/month, and being sued |
| Goomer (digital menu, Brazil) | flat monthly | R$ 59.94–299.90/month |
| Anota AI (iFood group) | flat monthly | R$ 247–400/month |

## What we still don't know

- The real price Pagar.me, Zoop or Iugu will give us (they only quote on
  request). **Don't put a price on the website until we have it.**
- qlub's price in Brazil.

## Glossary

- **Pix**: Brazil's instant bank transfer. Free for people; restaurants
  usually pay 0% at their machine.
- **MDR**: the % the card company keeps from each card sale.
- **Split**: the payment is divided automatically: most goes to the
  restaurant, Racha's fee goes to Racha. The money never passes through
  Racha's account (that keeps us out of Central Bank licensing).
- **PSP / payment provider**: the company that actually moves the money
  (Pagar.me, Zoop, Iugu). We pick one in the negotiation.
- **Antecipação / "get it today"**: card money normally takes 30 days to
  arrive. Getting it early costs a fee (about 1.25% a month at Asaas).
- **D+1, D+30**: the money arrives 1 day, or 30 days, after the sale.

## Sources (seen 2026-09-26)

Confirmed on the company's own page: Asaas (asaas.com/precos-e-taxas), Pagar.me
(pagar.me/ofertas), Cielo (blog.cielo.com.br), InfinitePay
(infinitepay.io/taxas), Ton (ton.com.br), Consumer (loja.consumer.com.br),
Saipos (saipos.com/planos-e-precos), Goomer (goomer.com.br blog), sunday
(sundayapp.com/pricing), iFood Na Mesa (institucional.ifood.com.br).

Second-hand (blogs, news, search results): qlub's %, the delivery
commission average (Abrasel/CNDL via brendi.com.br), iFood Maquinona rates,
Anota AI prices, the sunday lawsuit (classaction.org).
