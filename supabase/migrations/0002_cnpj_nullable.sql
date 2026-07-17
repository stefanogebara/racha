-- CNPJ is collected during onboarding but not required to create the venue
-- record (same posture as psp_recipient_id — filled in as the restaurant is
-- set up). The UI marks it "opcional"; the NOT NULL constraint made an
-- optional field 500 on the Supabase store while the memory store accepted
-- null (review finding, 2026-07-17). A fake placeholder CNPJ on real receipts
-- would be worse than null — so the column becomes nullable and both stores
-- pass null through unchanged.
alter table public.venues alter column cnpj drop not null;
