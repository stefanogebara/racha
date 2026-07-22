-- Aviso de status do recebedor (KYC). Guardamos o último status conhecido pra
-- detectar a transição (registration → active/refused) e avisar o dono UMA vez —
-- o cron compara o vivo (getRecipient) com este. E os contatos do dono pro aviso:
-- e-mail (o mesmo do form do recebedor) e WhatsApp (novo campo). O Racha não
-- guardava telefone em lugar nenhum — a auth compartilhada só traz o e-mail —,
-- então o WhatsApp precisa ser capturado aqui pra a Olímpia entregar o aviso.
alter table public.venues add column if not exists psp_recipient_status text;
alter table public.venues add column if not exists notify_email text;
alter table public.venues add column if not exists notify_whatsapp text;
