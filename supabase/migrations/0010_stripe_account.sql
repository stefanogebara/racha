-- Stripe Connect account por venue — o 2º rail (cartão/Apple Pay via Stripe).
-- Análogo do psp_recipient_id (Pagar.me, Pix), mas pra conta CONECTADA da Stripe
-- (acct_...) que recebe destination charges. Nullable: quase todo venue fica só
-- no Pix; só quem ligar cartão/Apple Pay ganha um acct_. Aditivo — nenhum fluxo
-- existente muda (reads de venue só passam a devolver a coluna, null por padrão).
alter table public.venues
  add column if not exists stripe_account_id text;

comment on column public.venues.stripe_account_id is
  'Stripe Connect connected account (acct_...) do restaurante — destino do destination charge no rail de cartão/Apple Pay. NULL = venue só no Pix (Pagar.me).';
