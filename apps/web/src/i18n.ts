/**
 * O dicionário e a matemática de apresentação — puro, sem React, sem DOM.
 *
 * Separado do `.tsx` de propósito e não por gosto: o `node --test` do Node 22
 * tira TIPOS sozinho, mas não transforma JSX. Com o dicionário dentro do
 * arquivo de componentes, nada disto seria testável sem trazer um bundler pro
 * caminho dos testes. É a mesma regra do `_lib/` do servidor: o que é puro fica
 * puro e é testado à exaustão.
 */
export type Lang = 'en' | 'pt';
export const LANGS: Lang[] = ['en', 'pt'];
export const STORAGE_KEY = 'racha-lang';

type Pair = { en: string; pt: string };

/** `{name}` é substituído pelos valores passados em `vars`. */
export function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export const DICT = {
  // ── cabeçalho / geral ───────────────────────────────────────────────────
  'app.tagline':      { en: 'racha · no app, no sign-up',      pt: 'racha · sem app, sem cadastro' },
  'lang.label':       { en: 'Language',                        pt: 'Idioma' },
  'lang.en':          { en: 'English',                         pt: 'Inglês' },
  'lang.pt':          { en: 'Português',                       pt: 'Português' },
  'common.loading':   { en: 'loading the bill…',               pt: 'carregando a conta…' },
  'common.back':      { en: '← back to the bill',              pt: '← voltar pra conta' },
  'common.optional':  { en: 'optional',                        pt: 'opcional' },

  // ── a conta ─────────────────────────────────────────────────────────────
  'check.yours':      { en: 'Your bill',                       pt: 'Sua conta' },
  'check.tapYours':   { en: ' · tap what was yours',           pt: ' · toque o que foi seu' },
  'check.total':      { en: 'Total',                           pt: 'Total' },
  'check.paidSoFar':  { en: '{paid} already paid — {left} to go',
                        pt: '{paid} já pagos — falta {left}' },
  'check.allPaid':    { en: 'Bill fully paid. Have a good night!',
                        pt: 'Conta paga por completo. Boa noite!' },
  'check.offline':    { en: 'no connection — amounts may be out of date',
                        pt: 'sem conexão — valores podem estar desatualizados' },

  // ── sua parte ───────────────────────────────────────────────────────────
  'share.title':      { en: 'Your share',                      pt: 'Sua parte' },
  'share.equal':      { en: 'Equally',                         pt: 'Igual' },
  'share.byItem':     { en: 'By item',                         pt: 'Por item' },
  'share.custom':     { en: 'Other amount',                    pt: 'Outro valor' },
  'share.splitAmong': { en: 'Split among',                     pt: 'Dividir entre' },
  'share.people':     { en: 'people',                          pt: 'pessoas' },
  'share.fewer':      { en: 'fewer people',                    pt: 'menos pessoas' },
  'share.more':       { en: 'more people',                     pt: 'mais pessoas' },
  'share.each':       { en: '{amount} each',                   pt: '{amount} por pessoa' },
  'share.overTotal':  { en: ' — the split is over the bill total, not over what is left',
                        pt: ' — a divisão é sobre o total da conta, não sobre o que falta' },
  'share.pickItems':  { en: 'Tap the items that were yours in the bill above — service follows your share.',
                        pt: 'Toque os itens que foram seus na conta ↑ — o serviço acompanha a sua parte.' },
  'share.picked':     { en: '{n} {noun} · your share {amount}', pt: '{n} {noun} · sua parte {amount}' },
  'share.item':       { en: 'item',                            pt: 'item' },
  'share.items':      { en: 'items',                           pt: 'itens' },
  'share.capped':     { en: 'Adjusted to what is still owed ({left}) — the rest is already paid.',
                        pt: 'Ajustado pro que ainda falta na conta ({left}) — o resto já foi pago.' },

  // ── serviço (CDC: sempre removível) ─────────────────────────────────────
  'servico.label':    { en: 'Staff service ({pct}% of your share) — optional',
                        pt: 'Serviço da equipe ({pct}% da sua parte) — opcional' },

  // ── identificação ───────────────────────────────────────────────────────
  'payer.name':       { en: 'Your name (optional)',            pt: 'Seu nome (opcional)' },
  'payer.cpf':        { en: 'Your CPF (required to pay)',      pt: 'Seu CPF (obrigatório pra pagar)' },
  'payer.cpfHint':    { en: 'Enter your CPF (11 digits) to enable payment.',
                        pt: 'Preencha seu CPF (11 dígitos) pra liberar o pagamento.' },

  // ── pagar ───────────────────────────────────────────────────────────────
  'pay.cta':          { en: 'Pay {amount} with Pix',           pt: 'Pagar {amount} com Pix' },
  'pay.retry':        { en: '{error} — the bill was refreshed, check the amount and try again.',
                        pt: '{error} — a conta foi atualizada, confira o valor e tente de novo.' },
  'pix.title':        { en: 'Pay with Pix',                    pt: 'Pague com Pix' },
  'pix.includesTip':  { en: 'includes {amount} of service for the staff',
                        pt: 'inclui {amount} de serviço para a equipe' },
  'pix.copy':         { en: 'Copy Pix code',                   pt: 'Copiar código Pix' },
  'pix.copied':       { en: 'Code copied ✓',                   pt: 'Código copiado ✓' },
  'pix.how':          { en: 'Open your bank app, choose Pix copy-and-paste and paste the code.',
                        pt: 'Abra o app do seu banco, escolha Pix copia-e-cola e cole o código.' },
  'pix.aria':         { en: 'Pix copy and paste',              pt: 'Pix copia e cola' },
  'pix.stillValid':   { en: 'no connection — the code below is still valid',
                        pt: 'sem conexão — o código abaixo continua valendo' },
  'pix.simulate':     { en: '✓ Simulate bank confirmation (demo)',
                        pt: '✓ Simular confirmação do banco (demo)' },
  'pix.simulating':   { en: 'confirming…',                     pt: 'confirmando…' },

  // ── pago ────────────────────────────────────────────────────────────────
  'paid.title':       { en: 'Payment confirmed',               pt: 'Pagamento confirmado' },
  'paid.thanks':      { en: 'Thanks, {name}! ',                pt: 'Valeu, {name}! ' },
  'paid.yours':       { en: 'Your share is paid.',             pt: 'Sua parte está paga.' },
  'paid.progress':    { en: '{paid} of {total} paid',          pt: '{paid} de {total} pagos' },
  'paid.left':        { en: ' — {left} to go',                 pt: ' — falta {left}' },
  'paid.closed':      { en: ' — bill closed 🎉',               pt: ' — conta fechada 🎉' },
  'paid.payMore':     { en: 'Pay another share',               pt: 'Pagar mais uma parte' },

  // ── saldo da casa ───────────────────────────────────────────────────────
  'house.pay':        { en: 'Pay with balance ({amount} available)',
                        pt: 'Pagar com saldo ({amount} disponível)' },
  'house.discover':   { en: 'Discover the house balance',      pt: 'Conheça o saldo da casa' },
  'house.bonus':      { en: 'Discover the house balance — get {pct}% bonus',
                        pt: 'Conheça o saldo da casa — ganhe {pct}% de bônus' },

  // ── erros do servidor, por código ───────────────────────────────────────
  'err.check_not_found':  { en: 'Bill not found.',             pt: 'Conta não encontrada.' },
  'err.check_closed':     { en: 'This bill is already closed.', pt: 'Esta conta já foi fechada.' },
  'err.amount_over':      { en: 'Amount is more than what is left ({left}).',
                            pt: 'Valor acima do que falta ({left}).' },
  'err.amount_invalid':   { en: 'Invalid amount.',             pt: 'Valor inválido.' },
  'err.zero_charge':      { en: 'Nothing to charge.',          pt: 'Cobrança de valor zero.' },
  'err.rate_limited':     { en: 'Too many attempts — wait a few minutes.',
                            pt: 'Muitas tentativas — aguarde alguns minutos.' },
  'err.no_card':          { en: 'This restaurant does not take card yet.',
                            pt: 'Este restaurante ainda não aceita cartão.' },
  'err.generic':          { en: 'Something went wrong. Try again.',
                            pt: 'Algo deu errado. Tente de novo.' },

  // ── landing (/) ─────────────────────────────────────────────────────────
  'home.how':         { en: 'How it works',                    pt: 'Como funciona' },
  'home.scan':        { en: 'Scan the QR on your table…',      pt: 'Escaneie o QR…' },
  'home.forVenues':   { en: 'For restaurants and bars',        pt: 'Para restaurantes e bares' },
  'home.pixDirect':   { en: 'Pix straight into the restaurant’s account',
                        pt: 'Pix direto na conta do restaurante' },
  'home.houseBalance':{ en: 'House balance',                   pt: 'Saldo da casa' },

  // ── painel do restaurante ───────────────────────────────────────────────
  'panel.loading':    { en: 'loading the floor…',              pt: 'carregando o salão…' },
  'panel.activation': { en: 'Activation — last 7 days',        pt: 'Ativação — últimos 7 dias' },
  'panel.noMovement': { en: 'no movement in the last 7 days.', pt: 'sem movimento nos últimos 7 dias.' },
  'panel.recon':      { en: 'Reconciliation',                  pt: 'Conciliação' },
  'panel.reconOk':    { en: 'Everything matches ✓ — {n} bills checked at {time}',
                        pt: 'Tudo bate ✓ — {n} contas conferidas às {time}' },
  'panel.reconDrift': { en: 'Mismatch between the ledger and the payments.',
                        pt: 'Divergência entre o registro e os pagamentos.' },
  'panel.reconManual':{ en: 'This does not fix itself, on purpose.',
                        pt: 'Isso não corrige sozinho, de propósito.' },
  'panel.noAnomaly':  { en: 'no anomalies ✓',                  pt: 'nenhuma anomalia ✓' },
  'panel.tip':        { en: 'staff service (payroll)',         pt: 'serviço da equipe (folha)' },

  // ── carteira ────────────────────────────────────────────────────────────
  'wallet.open':      { en: 'Open your wallet',                pt: 'Abrir sua carteira' },
  'wallet.create':    { en: 'Create wallet',                   pt: 'Criar carteira' },
  'wallet.yourName':  { en: 'Your name',                       pt: 'Seu nome' },
  'wallet.phone':     { en: 'Phone with area code (digits only)',
                        pt: 'Telefone com DDD (só números)' },
  'wallet.balance':   { en: 'Your balance',                    pt: 'Seu saldo' },
  'wallet.topUp':     { en: 'Top up balance',                  pt: 'Carregar saldo' },
  'wallet.topUpPix':  { en: 'Top up with Pix',                 pt: 'Carregar com Pix' },
  'wallet.pitch':     { en: 'Top up by Pix and pay the bill straight from your phone.',
                        pt: 'Carregue saldo por Pix e pague a conta direto do celular.' },
  'wallet.paidBal':   { en: 'Paid balance',                    pt: 'Saldo pago' },
  'wallet.bonus':     { en: 'Promotional bonus',               pt: 'Bônus promocional' },
  'wallet.refundable':{ en: 'Paid balance never expires and is refundable.',
                        pt: 'Saldo pago não expira e é reembolsável.' },
  'wallet.noMoves':   { en: 'no activity yet.',                pt: 'nenhuma movimentação ainda.' },
  'wallet.exists':    { en: 'Account already exists — ask for your link at the counter',
                        pt: 'Conta já existe — peça seu link no balcão' },
  'wallet.badLink':   { en: 'Invalid link — ask for a new one at the counter.',
                        pt: 'Link inválido — peça um novo no balcão.' },
  'wallet.atTable':   { en: 'Pay at the table',                pt: 'Pagamento na mesa' },

  // ── pagar com saldo ─────────────────────────────────────────────────────
  'housepay.cta':     { en: 'Pay with balance',                pt: 'Pagar com saldo' },
  'housepay.done':    { en: 'Paid with balance',               pt: 'Pago com saldo' },
  'housepay.tipApart':{ en: 'Staff service (tip) goes separately, by Pix.',
                        pt: 'O serviço da equipe (gorjeta) vai separado, pelo Pix.' },

  // ── carteiras de cartão ─────────────────────────────────────────────────
  'card.gpayOut':     { en: 'Google Pay unavailable',          pt: 'Google Pay indisponível' },
  'card.gpayFail':    { en: 'could not load Google Pay',       pt: 'não deu para carregar o Google Pay' },
  'card.demoNote':    { en: 'simulation (demo) — no real charge is made',
                        pt: 'simulação (demo) — nenhuma cobrança real é feita' },
  'card.validateFail':{ en: 'could not validate the payment',  pt: 'não deu para validar o pagamento' },
  'card.incomplete':  { en: 'payment not completed',           pt: 'pagamento não concluído' },
  'card.word':        { en: 'card',                            pt: 'cartão' },

  // ── login do restaurante ────────────────────────────────────────────────
  'gate.title':       { en: 'racha · restaurant area',         pt: 'racha · área do restaurante' },
  'gate.signUp':      { en: 'Create account',                  pt: 'Criar conta' },
  'gate.haveAccount': { en: 'I already have an account',       pt: 'Já tenho conta' },
  'gate.forgot':      { en: 'Forgot password',                 pt: 'Esqueci a senha' },
  'gate.emailFirst':  { en: 'Type your e-mail first.',         pt: 'Digite seu e-mail primeiro.' },
  'gate.resetSent':   { en: 'We sent a reset link to your e-mail.',
                        pt: 'Enviamos um link de redefinição pro seu e-mail.' },
  'gate.created':     { en: 'Account created! Check your e-mail to confirm, then sign in.',
                        pt: 'Conta criada! Confira seu e-mail pra confirmar e depois entre.' },

  // ── cartões de QR ───────────────────────────────────────────────────────
  'qr.scanToPay':     { en: 'Scan to see the bill, split it and pay by Pix',
                        pt: 'Escaneie para ver a conta, dividir e pagar no Pix' },
  'qr.sheetNote':     { en: 'racha · one card per table, 2 per A4 sheet',
                        pt: 'racha · um cartão por mesa, 2 por folha A4' },

  // ── landing, texto de venda ─────────────────────────────────────────────
  'home.tagline':     { en: 'pay at the table',                pt: 'pagamento na mesa' },
  'home.h1':          { en: 'The table’s bill, settled on Pix.',
                        pt: 'A conta da mesa, resolvida no Pix.' },
  'home.lede':        { en: 'Your guest scans the QR, splits it however they like and pays in seconds — no app, no sign-up, no waiting for the card machine. Card via Google\u00a0Pay and prepaid balance with bonus, on the same QR.',
                        pt: 'O cliente escaneia o QR, divide como quiser e paga em segundos — sem app, sem cadastro, sem esperar a maquininha. Cartão via Google\u00a0Pay e saldo pré-pago com bônus, no mesmo QR.' },
  'home.demo':        { en: 'See the live demo',               pt: 'Ver a demonstração ao vivo' },
  'home.iAmVenue':    { en: 'I’m a restaurant — go to the panel',
                        pt: 'Sou restaurante — entrar no painel' },
  'home.step1':       { en: '1 · Scanned',                     pt: '1 · Escaneou' },
  'home.step1d':      { en: 'the table QR opens the bill right away',
                        pt: 'o QR da mesa abre a conta na hora' },
  'home.step2':       { en: '2 · Split',                       pt: '2 · Dividiu' },
  'home.step2d':      { en: 'equally or by amount — each their own share',
                        pt: 'igual ou por valor — cada um a sua parte' },
  'home.step3':       { en: '3 · Paid',                        pt: '3 · Pagou' },
  'home.legal':       { en: 'Staff service (tip) tracked separately, the way the law requires. The table turns faster at the rush — and nobody waits for a card machine passed hand to hand.',
                        pt: 'Serviço da equipe (gorjeta) rastreado separado, do jeito que a lei pede. A mesa gira mais rápido no rush — e ninguém fica esperando maquininha passar de mão em mão.' },
  'home.balancePitch':{ en: 'Your guest tops up by Pix and earns a bonus (e.g. +15%). Loyalty that becomes cash up front — the paid balance never expires and is refundable; the bonus is promotional, with a clear expiry.',
                        pt: 'Seu cliente carrega saldo via Pix e ganha bônus (ex.: +15%). Fidelidade que vira caixa antecipado — o saldo pago não expira e é reembolsável; o bônus é promocional, com validade clara.' },

  // ── carteira, continuação ───────────────────────────────────────────────
  'wallet.statement': { en: 'Statement',                       pt: 'Extrato' },
  'wallet.topUpEntry':{ en: 'Top-up',                          pt: 'Recarga' },
  'wallet.bonusOf':   { en: 'of bonus',                        pt: 'de bônus' },
  'wallet.otherAmt':  { en: 'other amount',                    pt: 'outro valor' },
  'wallet.onlyAt':    { en: 'Valid only at {venue}.',          pt: 'Válido somente no {venue}.' },
  'wallet.expires':   { en: 'expires on {date}',               pt: 'expira em {date}' },
  'wallet.neverExp':  { en: 'never expires and is refundable', pt: 'não expira e é reembolsável' },
  'wallet.rules':     { en: 'Paid balance never expires and is refundable. Bonus valid for 90 days after confirmation.',
                        pt: 'Saldo pago não expira e é reembolsável. Bônus válido por 90 dias após a confirmação.' },
  'wallet.doTopUp':   { en: 'Top up {amount}',                 pt: 'Carregar {amount}' },

  // ── login ───────────────────────────────────────────────────────────────
  'gate.google':      { en: 'Continue with Google',            pt: 'Continuar com Google' },
  'gate.orEmail':     { en: 'or with e-mail',                  pt: 'ou com e-mail' },
  'gate.email':       { en: 'e-mail',                          pt: 'e-mail' },
  'gate.password':    { en: 'password',                        pt: 'senha' },
  'gate.signIn':      { en: 'Sign in',                         pt: 'Entrar' },
  'gate.ownerPanel':  { en: 'owner panel',                     pt: 'painel do dono' },

  // ── admin ───────────────────────────────────────────────────────────────
  'admin.title':      { en: 'racha · management',              pt: 'racha · gestão' },
  'admin.suggested':  { en: 'Suggested service',               pt: 'Serviço sugerido' },
  'admin.saved':      { en: 'saved ✓',                         pt: 'salvo ✓' },
  'admin.houseOn':    { en: 'Guests can top up prepaid balance with a bonus',
                        pt: 'Clientes podem carregar saldo pré-pago com bônus' },
  'admin.point':      { en: 'Point the camera · pay your share with Pix',
                        pt: 'Aponte a câmera · pague sua parte por Pix' },
  'qr.perks':         { en: '💳 Google Pay · 💰 House balance with bonus',
                        pt: '💳 Google Pay · 💰 Saldo da casa com bônus' },

  // ── cartão (demo) ───────────────────────────────────────────────────────
  'card.demoCard':    { en: '•••• 4242 (demo)',                pt: '•••• 4242 (demo)' },

  'gate.newPassword': { en: 'create a password',              pt: 'crie uma senha' },
  'wallet.bonusOnConfirm': { en: '+{amount} bonus when the payment confirms',
                             pt: '+{amount} de bônus quando o pagamento confirmar' },
  'wallet.bonusLine': { en: ' · +{amount} bonus',             pt: ' · +{amount} de bônus' },
  'wallet.pitchBonus': { en: 'Top up by Pix and get {pct}% bonus on every top-up.',
                         pt: 'Carregue saldo por Pix e ganhe {pct}% de bônus em cada recarga.' },
  'wallet.rulesFull':  { en: 'Paid balance never expires and is refundable. The promotional bonus is valid for {days} days. Valid only at {venue}.',
                         pt: 'Saldo pago não expira e é reembolsável. O bônus promocional vale por {days} dias. Válido somente no {venue}.' },

  'ledger.load':   { en: 'Top-up',        pt: 'Recarga' },
  'ledger.redeem': { en: 'Paid at table', pt: 'Pagamento na mesa' },
  'ledger.refund': { en: 'Refund',        pt: 'Reembolso' },

  'wallet.bonusDays': { en: 'Bonus valid for {days} days after confirmation.',
                        pt: 'Bônus válido por {days} dias após a confirmação.' },
  'wallet.brand':     { en: 'racha · house balance',    pt: 'racha · saldo da casa' },
  'wallet.noHouse':   { en: '{venue} does not offer a house balance yet.',
                        pt: 'O {venue} ainda não oferece saldo da casa.' },

  // ── landing: o herói (a noite do bar) ───────────────────────────────────
  'land.eyebrow':   { en: 'Pay at the table · Brazil',        pt: 'Pagamento na mesa · Brasil' },
  'land.h1a':       { en: 'Say who had what.',                pt: 'Fala o que foi de quem.' },
  'land.h1b':       { en: 'I’ll do the bill.',                pt: 'Eu faço a conta.' },
  'land.sub':       { en: 'Scan the table QR, say who had what, and everyone pays the house straight over Pix. No app, no sign-up, no card machine passed around the table.',
                      pt: 'Escaneia o QR da mesa, fala o que foi de quem, e cada um paga a casa direto no Pix. Sem app, sem cadastro, sem maquininha passando de mão em mão.' },
  'land.try':       { en: 'Try the live demo',                pt: 'Experimente a demo ao vivo' },
  'land.tryHint':   { en: 'This phone is the real product. Tap it.',
                      pt: 'Este telefone é o produto de verdade. Toque nele.' },
  'land.forVenues': { en: 'I run a restaurant',               pt: 'Tenho um restaurante' },
  'land.proof1':    { en: 'Pix settles to the restaurant’s own account', pt: 'O Pix cai na conta do próprio restaurante' },
  'land.proof2':    { en: 'Service charge optional, tracked for payroll', pt: 'Serviço opcional, rastreado pra folha' },
  'land.proof3':    { en: 'We never hold your money',           pt: 'A gente nunca segura o seu dinheiro' },
  'land.menuLabel': { en: 'Every line gets its block',          pt: 'Cada linha tem seu bloco' },
  'land.menuSub':   { en: 'Fourteen woodcuts, carved in one pass, one for each thing a bar bill prints.',
                      pt: 'Catorze xilogravuras, entalhadas de uma vez, uma pra cada coisa que uma conta de bar imprime.' },
  'land.venueTitle':{ en: 'For the house',                     pt: 'Para a casa' },
  'land.venueSub':  { en: 'The table turns faster at the rush. Tips go to payroll, the way the law wants. Reconciliation to the cent, every night.',
                      pt: 'A mesa gira mais rápido no rush. Gorjeta vai pra folha, do jeito que a lei pede. Conciliação ao centavo, toda noite.' },
  'land.openPanel': { en: 'Open the restaurant panel',         pt: 'Abrir o painel do restaurante' },

  'cat.carne': { en: 'Meat', pt: 'Carne' }, 'cat.peixe': { en: 'Fish', pt: 'Peixe' },
  'cat.massa': { en: 'Pasta', pt: 'Massa' }, 'cat.petisco': { en: 'Snacks', pt: 'Petisco' },
  'cat.salada': { en: 'Salad', pt: 'Salada' }, 'cat.acompanhamento': { en: 'Sides', pt: 'Acompanhamento' },
  'cat.sobremesa': { en: 'Dessert', pt: 'Sobremesa' }, 'cat.cerveja': { en: 'Beer', pt: 'Cerveja' },
  'cat.drink': { en: 'Cocktail', pt: 'Drink' }, 'cat.vinho': { en: 'Wine', pt: 'Vinho' },
  'cat.refrigerante': { en: 'Soft drink', pt: 'Refrigerante' }, 'cat.cafe': { en: 'Coffee', pt: 'Café' },
  'cat.suco': { en: 'Juice', pt: 'Suco' }, 'cat.couvert': { en: 'Couvert', pt: 'Couvert' },
  'land.proofs':    { en: 'Pix lands in the restaurant’s own account · Service optional, tracked for payroll · We never hold your money',
                      pt: 'O Pix cai na conta do próprio restaurante · Serviço opcional, rastreado pra folha · A gente nunca segura o seu dinheiro' },
  'land.specimen':  { en: 'The bill, illustrated',              pt: 'A conta, ilustrada' },
  'land.specimenSub':{ en: 'One woodcut for each thing a bar bill prints.',
                       pt: 'Uma xilogravura pra cada coisa que uma conta de bar imprime.' },
  'land.h2how':     { en: 'Three moves. Under a minute.',        pt: 'Três gestos. Menos de um minuto.' },
  'land.house1':    { en: 'The table turns faster at the rush.', pt: 'A mesa gira mais rápido no rush.' },
  'land.house2':    { en: 'Tips reach payroll, as the law requires.', pt: 'A gorjeta chega na folha, como a lei exige.' },
  'land.house3':    { en: 'Reconciled to the cent, every night.', pt: 'Conciliado ao centavo, toda noite.' },
  'land.house4':    { en: 'Prepaid house balance turns loyalty into cash up front.', pt: 'Saldo da casa pré-pago transforma fidelidade em caixa antecipado.' },

  'land.nav':      { en: 'For restaurants',                pt: 'Para restaurantes' },
  'land.house0':   { en: 'Pix lands in the restaurant’s own account. We never hold the money.',
                     pt: 'O Pix cai na conta do próprio restaurante. A gente nunca segura o dinheiro.' },

  'land.proofTitle': { en: 'To the cent. Always.',            pt: 'Ao centavo. Sempre.' },
  'land.proofSub':   { en: 'Every split sums back to the bill exactly. When the centavos don’t divide, the remainder goes to one share — never rounded away, never invented.',
                       pt: 'Toda divisão soma de volta à conta, exata. Quando os centavos não dividem, o resto vai pra uma parte — nunca arredondado fora, nunca inventado.' },
  'land.proofEach':  { en: 'each', pt: 'cada' },
  'land.proofRem':   { en: 'the remaining centavo', pt: 'o centavo que sobra' },

  'land.proofCap':  { en: 'Three shares. The centavo that won’t divide lands on one of them — never rounded away, never invented.',
                      pt: 'Três partes. O centavo que não divide cai numa delas — nunca arredondado fora, nunca inventado.' },
} satisfies Record<string, Pair>;

export type Key = keyof typeof DICT;


/**
 * Dinheiro. A MOEDA não muda com o idioma — a conta é em reais nos dois casos,
 * e "R$" continua "R$". O que muda é a separação: um leitor de inglês lê
 * "R$ 1.234,56" como mil e duzentos reais e trinta e quatro centavos errados.
 */
export function money(cents: number, lang: Lang): string {
  return (cents / 100).toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US', {
    style: 'currency', currency: 'BRL',
  });
}

/** Tradução de um erro do servidor pelo CÓDIGO, com o texto dele como reserva. */
export function tError(lang: Lang, code: string | undefined, fallback: string,
                       vars?: Record<string, string | number>): string {
  const key = `err.${code}` as Key;
  if (code && key in DICT) return fill(DICT[key][lang], vars);
  return fallback;   // servidor antigo ou erro novo: o texto cru é melhor que nada
}

