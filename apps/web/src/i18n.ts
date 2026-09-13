/**
 * O dicionário e a matemática de apresentação — puro, sem React, sem DOM.
 *
 * Separado do `.tsx` de propósito e não por gosto: o `node --test` do Node 22
 * tira TIPOS sozinho, mas não transforma JSX. Com o dicionário dentro do
 * arquivo de componentes, nada disto seria testável sem trazer um bundler pro
 * caminho dos testes. É a mesma regra do `_lib/` do servidor: o que é puro fica
 * puro e é testado à exaustão.
 */
export type Lang = 'en' | 'pt' | 'es';
export const LANGS: Lang[] = ['en', 'pt', 'es'];
export const STORAGE_KEY = 'racha-lang';

/**
 * Um idioma que o produto realmente atende, ou `null`.
 *
 * Existe como função — e aqui, no módulo puro — porque a lista escrita à mão
 * foi o bug. Quando a Espanha entrou, o caminho do `?lang=` ganhou o `'es'` e
 * o do localStorage NÃO: a pessoa escolhia espanhol, a escolha era gravada, e
 * o recarregamento devolvia inglês. Numa mesa isso é a conta trocando de
 * idioma sozinha entre um toque e o seguinte, na hora de pagar.
 *
 * Validar contra `LANGS` — a mesma lista que desenha o seletor — é o que
 * impede acrescentar um quarto idioma e esquecer uma das portas.
 */
export function asLang(v: unknown): Lang | null {
  return (LANGS as readonly string[]).includes(v as string) ? (v as Lang) : null;
}

/**
 * Três línguas na MESMA chave, lado a lado — não três objetos paralelos.
 *
 * É a decisão #34 mantida quando o produto abriu a Espanha: com objetos
 * separados, acrescentar uma frase e esquecer uma das línguas compila, passa
 * no teste, e aparece como uma frase em inglês no meio de uma tela em
 * espanhol, no telefone de alguém, num bar, na hora de pagar. Com o trio, a
 * falta de um lado é erro de tipo. E lado a lado é também como um tradutor
 * consegue conferir: as três versões de uma frase à vista de uma vez.
 */
type Trio = { en: string; pt: string; es: string };

/** `{name}` é substituído pelos valores passados em `vars`. */
export function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

export const DICT = {
  // ── cabeçalho / geral ───────────────────────────────────────────────────
  // ── O AVISO DE PRIVACIDADE DO CLIENTE (art. 9º) ──────────────────────────
  //
  // Lacuna 2 do `docs/compliance/data-map.md`, e a que bloqueia o primeiro QR
  // numa mesa de cliente de verdade: a tela da conta não dizia quem trata, pra
  // quê, pra quem vai, nem por quanto tempo. O art. 9º não pede um contrato —
  // pede que a informação esteja CLARA e ACESSÍVEL antes de a pessoa decidir.
  //
  // Escrito depois do `docs/compliance/retencao.md` de propósito: um aviso tem
  // que dizer prazo, e prazo escrito sem job que o cumpra é promessa falsa.
  // Cada linha daqui aponta pra uma defesa que existe no código.
  // A conta pode ainda não ter sido aberta pelo garçom — e nesse caso a tela
  // fica só com "conta não encontrada", sem sinal nenhum de que o app continua
  // tentando. Sessenta segundos de nada parecem um app quebrado.
  'check.stillChecking': { en: 'Still checking — the bill appears as soon as the staff opens it.',
                        pt: 'Continuamos verificando — a conta aparece assim que a equipe abrir.',
                        es: 'Seguimos comprobando — la cuenta aparece en cuanto el personal la abra.' },
  'priv.link':        { en: 'Your data',                       pt: 'Seus dados', es: 'Tus datos' },
  // A CAMADA 1. Um controle que só diz "seus dados" é um rótulo, não um aviso:
  // quem não abrir não recebe informação nenhuma, e o art. 9º pede informação
  // antes da decisão. Esta linha fica SEMPRE visível e responde as três
  // perguntas — quem, o quê, por quanto tempo — em uma frase.
  // A expiração e a restrição de DINHEIRO PRÉ-PAGO, que estavam em português
  // cru numa tela servida em três idiomas. É informação do art. 6º III / art.
  // 31 do CDC sobre o que a pessoa está comprando.
  'wallet.bonusTerms': { en: 'The promotional bonus is valid for {days} days. Good only at {venue}.',
                        pt: 'O bônus promocional vale por {days} dias. Válido somente no {venue}.',
                        es: 'El bono promocional vale {days} días. Válido solo en {venue}.' },
  // O número vem de FORA (`{days}`), não escrito na frase: havia nove "90" no
  // bloco `priv.*` e o teste que amarra promessa↔job só via os três do
  // `priv.what1`. A camada 1 — a única linha que todo cliente lê — era uma das
  // não amarradas. "até 90 dias DEPOIS DE A CONTA FECHAR", que é a regra.
  'priv.teaser':      { en: '{venue} keeps the name you type for up to {days} days after the bill closes; Racha runs the payment.',
                        pt: '{venue} guarda o nome que você digita por até {days} dias depois de a conta fechar; a Racha opera o pagamento.',
                        es: '{venue} guarda el nombre que escribes hasta {days} días después de cerrar la cuenta; Racha ejecuta el pago.' },
  'priv.title':       { en: 'What happens to your data',       pt: 'O que acontece com seus dados', es: 'Qué pasa con tus datos' },
  // Nomeia o controlador (art. 9º III) e diz o que a Racha trata EM NOME
  // PRÓPRIO — a primeira versão dizia que "o restaurante decide tudo", e o
  // próprio mapa de dados estabelece que a medição de adoção é finalidade
  // nossa, sob legítimo interesse. Negar isso ao cliente era fechar metade da
  // lacuna e chamar de fechada.
  'priv.who':         { en: '{venue} ({taxId}) decides what is collected to close your bill and why; Racha runs the payment for them. Separately, and in its own name, Racha counts how many people open a bill — a random per-tab number, no name attached — to know whether the product is being used.',
                        pt: '{venue} ({taxId}) é quem decide o que se coleta pra fechar sua conta e pra quê; a Racha opera o pagamento por ele. À parte, e em nome próprio, a Racha conta quantas pessoas abrem uma conta — um número aleatório por aba, sem nome nenhum junto — pra saber se o produto está sendo usado.',
                        es: '{venue} ({taxId}) decide qué se recoge para cerrar tu cuenta y para qué; Racha ejecuta el pago por él. Aparte, y en nombre propio, Racha cuenta cuántas personas abren una cuenta — un número aleatorio por pestaña, sin nombre — para saber si el producto se usa.' },
  'priv.whatTitle':   { en: 'What we keep',                    pt: 'O que fica guardado', es: 'Qué se guarda' },
  // "apagado DA RACHA": o nome vai junto na descrição da cobrança, então o
  // provedor de pagamento guarda o registro dele sob as regras dele. Prometer
  // "apagado" sem essa metade era prometer o que a gente não controla.
  'priv.what1':       { en: 'The name you type, so the table can see who paid which part. It is erased from Racha {days} days after the bill closes — the amount stays, the name does not. The payment provider keeps its own record of the charge under its own terms.',
                        pt: 'O nome que você digita, pra mesa ver quem pagou qual parte. Ele é apagado da Racha {days} dias depois de a conta fechar — o valor fica, o nome não. O provedor de pagamento guarda o registro da cobrança dele sob as regras dele.',
                        es: 'El nombre que escribes, para que la mesa vea quién pagó qué parte. Se borra de Racha {days} días después de cerrar la cuenta — el importe queda, el nombre no. El proveedor de pago guarda su propio registro del cobro bajo sus condiciones.' },
  'priv.what2':       { en: 'The amount, the method and the time of the payment, kept as an accounting record.',
                        pt: 'O valor, o meio e a hora do pagamento, guardados como registro contábil.',
                        es: 'El importe, el método y la hora del pago, guardados como registro contable.' },
  'priv.noTitle':     { en: 'What never gets here',            pt: 'O que nunca chega aqui', es: 'Lo que nunca llega aquí' },
  'priv.no1':         { en: 'Your card number. The card fields belong to the payment provider and the data goes straight to them.',
                        pt: 'O número do seu cartão. Os campos de cartão são do provedor de pagamento e os dados vão direto pra ele.',
                        es: 'El número de tu tarjeta. Los campos de tarjeta son del proveedor de pago y los datos van directos a él.' },
  'priv.no2':         { en: 'Your tax ID, if you type one. It is passed to the payment provider to issue the charge and is not stored here.',
                        pt: 'Seu CPF, se você digitar um. Ele é repassado ao provedor de pagamento pra emitir a cobrança e não fica guardado aqui.',
                        es: 'Tu documento fiscal, si escribes uno. Se pasa al proveedor de pago para emitir el cobro y no se guarda aquí.' },
  'priv.no3':         { en: 'A login. You never create an account to pay a bill.',
                        pt: 'Um cadastro. Você nunca cria conta pra pagar uma conta.',
                        es: 'Un registro. Nunca creas una cuenta para pagar una cuenta.' },
  // A carteira pré-paga. O telefone é o dado mais identificável que este
  // produto recebe, e a primeira versão do aviso não o mencionava — a tela que
  // o COLETA também não tinha aviso nenhum.
  'priv.what3':       { en: 'If you open a prepaid wallet at the restaurant, the name and phone you give, for as long as the wallet exists — and for {days} days after it is empty and unused.',
                        pt: 'Se você abrir uma carteira pré-paga no restaurante, o nome e o telefone que você informa, enquanto a carteira existir — e por {days} dias depois de ela ficar vazia e sem uso.',
                        es: 'Si abres una cartera prepago en el restaurante, el nombre y el teléfono que das, mientras la cartera exista — y {days} días después de quedar vacía y sin uso.' },
  'priv.whoElseTitle': { en: 'Who else sees it',               pt: 'Quem mais vê', es: 'Quién más lo ve' },
  // "Mais ninguém" era falso. Existe uma ponte de OPERAÇÃO que leva o
  // identificador da cobrança e o valor pra quem cuida do sistema — e o mapa de
  // dados diz, com todas as letras, que esse identificador resolve pro cadastro
  // do pagador no painel do adquirente. Omitir isso e escrever "mais ninguém"
  // era o aviso afirmando menos do que o código faz, que é o defeito que este
  // aviso existe pra corrigir.
  'priv.whoElse':     { en: 'The payment provider that issues the charge and settles the money to the restaurant; the companies that host the app and the database; and an operations channel that receives the charge reference and the amount so faults can be found. Never for advertising, and never sold.',
                        pt: 'O provedor de pagamento que emite a cobrança e liquida o dinheiro pro restaurante; as empresas que hospedam o app e o banco de dados; e um canal de operação que recebe a referência da cobrança e o valor, pra que falhas sejam encontradas. Nunca pra publicidade, e nunca vendido.',
                        es: 'El proveedor de pago que emite el cobro y liquida el dinero al restaurante; las empresas que alojan la app y la base de datos; y un canal de operación que recibe la referencia del cobro y el importe, para poder encontrar fallos. Nunca para publicidad, y nunca vendido.' },
  // Inclui o direito de OPOR-SE, que é o que acompanha legítimo interesse
  // (art. 18 §2), e um canal DIRETO — "fale com o restaurante" como única via
  // lê como desvio, e o consumidor pode vir direto de qualquer jeito (CDC art.
  // 7º § único).
  // DUAS versões, e a diferença é se existe caixa de correio DE VERDADE.
  //
  // A primeira versão publicou `privacidade@racha.com.br` — um endereço que eu
  // inventei. O `dig` diz `MX 0 .`: MX nulo (RFC 7505), o domínio declara
  // explicitamente que NÃO recebe e-mail. Um cliente que escrevesse pra lá
  // levava bounce, e o canal que o `retencao.md` tinha acabado de chamar de "a
  // condição que faltava" faltava de novo. É o mesmo erro do `racha.app`, uma
  // camada pior: lá a frase falsa CONCEDIA confiança, aqui ela promete um
  // direito a um consumidor na hora de pagar.
  //
  // Então o endereço vem de fora (`VITE_PRIVACY_CONTACT`) e, sem ele, a frase
  // do canal direto simplesmente não existe. Publicar caixa que não existe é
  // pior do que mandar a pessoa ao restaurante, que é o controlador de verdade
  // do dado do pagamento.
  'priv.rights':      { en: 'You can ask what is kept about you, have it corrected or erased, and object to the counting described above. Ask {venue}, or write to {email} and we will act with them.',
                        pt: 'Você pode pedir o que está guardado sobre você, pedir correção ou exclusão, e se opor à contagem descrita acima. Peça a {venue}, ou escreva para {email} e a gente resolve junto com ele.',
                        es: 'Puedes pedir qué se guarda sobre ti, pedir corrección o supresión, y oponerte al recuento descrito arriba. Pídeselo a {venue}, o escribe a {email} y lo resolvemos con él.' },
  'priv.rightsNoEmail': { en: 'You can ask what is kept about you, have it corrected or erased, and object to the counting described above. Ask {venue} and they will reach us.',
                        pt: 'Você pode pedir o que está guardado sobre você, pedir correção ou exclusão, e se opor à contagem descrita acima. Peça a {venue} e ele chega até a gente.',
                        es: 'Puedes pedir qué se guarda sobre ti, pedir corrección o supresión, y oponerte al recuento descrito arriba. Pídeselo a {venue} y llegará hasta nosotros.' },
  'priv.close':       { en: 'Close',                           pt: 'Fechar', es: 'Cerrar' },
  'app.tagline':      { en: 'racha · no app, no sign-up',      pt: 'racha · sem app, sem cadastro', es: 'racha · sin app, sin registro' },
  'lang.label':       { en: 'Language',                        pt: 'Idioma', es: 'Idioma' },
  // O título do documento: é a aba do navegador e o nome que aparece quando
  // alguém compartilha o link da conta. Era uma linha fixa em inglês no
  // `index.html`, então a única tela que NUNCA traduzia era a que o sistema
  // operacional mostra por cima de todas as outras.
  'doc.title':        { en: 'Racha — pay at the table',        pt: 'Racha — pague na mesa', es: 'Racha — paga en la mesa' },
  'lang.en':          { en: 'English',                         pt: 'Inglês', es: 'Inglés' },
  'lang.pt':          { en: 'Portuguese',                      pt: 'Português', es: 'Portugués' },
  'lang.es':          { en: 'Spanish',                         pt: 'Espanhol', es: 'Español' },
  'common.loading':   { en: 'loading the bill…',               pt: 'carregando a conta…', es: 'cargando la cuenta…' },
  'common.back':      { en: '← back to the bill',              pt: '← voltar pra conta', es: '← volver a la cuenta' },
  'common.optional':  { en: 'optional',                        pt: 'opcional', es: 'opcional' },
  'common.backShort': { en: '← back',                          pt: '← voltar', es: '← volver' },
  'common.backWallet':{ en: '← back to the wallet',            pt: '← voltar pra carteira', es: '← volver al monedero' },

  // ── a conta ─────────────────────────────────────────────────────────────
  'check.yours':      { en: 'Your bill',                       pt: 'Sua conta', es: 'Tu cuenta' },
  'check.tapYours':   { en: ' · tap what you had',             pt: ' · toque o que foi seu', es: ' · toca lo que fue tuyo' },
  'check.total':      { en: 'Total',                           pt: 'Total', es: 'Total' },
  'check.paidSoFar':  { en: '{paid} already paid — {left} to go',
                        pt: '{paid} já pagos — falta {left}',
                        es: '{paid} ya pagados — faltan {left}' },
  'check.allPaid':    { en: 'Bill fully paid. Have a good night!',
                        pt: 'Conta paga por completo. Boa noite!',
                        es: 'Cuenta pagada por completo. ¡Buena noche!' },
  'check.offline':    { en: 'no connection — amounts may be out of date',
                        pt: 'sem conexão — valores podem estar desatualizados',
                        es: 'sin conexión — los importes pueden estar desactualizados' },

  // ── sua parte ───────────────────────────────────────────────────────────
  'share.title':      { en: 'Your share',                      pt: 'Sua parte', es: 'Tu parte' },
  'share.equal':      { en: 'Equally',                         pt: 'Igual', es: 'Por igual' },
  'share.byItem':     { en: 'By item',                         pt: 'Por item', es: 'Por producto' },
  'share.custom':     { en: 'Other amount',                    pt: 'Outro valor', es: 'Otro importe' },
  'share.splitAmong': { en: 'Split among',                     pt: 'Dividir entre', es: 'Dividir entre' },
  'share.people':     { en: 'people',                          pt: 'pessoas', es: 'personas' },
  'share.fewer':      { en: 'fewer people',                    pt: 'menos pessoas', es: 'menos personas' },
  'share.more':       { en: 'more people',                     pt: 'mais pessoas', es: 'más personas' },
  'share.each':       { en: '{amount} each',                   pt: '{amount} por pessoa', es: '{amount} cada uno' },
  'share.overTotal':  { en: ' — the split is over the bill total, not over what is left',
                        pt: ' — a divisão é sobre o total da conta, não sobre o que falta',
                        es: ' — la división es sobre el total de la cuenta, no sobre lo que falta' },
  'share.pickItems':  { en: 'Tap the items you had in the bill above — the service charge follows your share.',
                        pt: 'Toque os itens que foram seus na conta ↑ — o serviço acompanha a sua parte.',
                        es: 'Toca los productos que fueron tuyos en la cuenta de arriba — el servicio sigue a tu parte.' },
  'share.picked':     { en: '{n} {noun} · your share {amount}', pt: '{n} {noun} · sua parte {amount}', es: '{n} {noun} · tu parte {amount}' },
  'share.item':       { en: 'item',                            pt: 'item', es: 'producto' },
  'share.items':      { en: 'items',                           pt: 'itens', es: 'productos' },
  'share.capped':     { en: 'Adjusted to what is still owed ({left}) — the rest is already paid.',
                        pt: 'Ajustado pro que ainda falta na conta ({left}) — o resto já foi pago.',
                        es: 'Ajustado a lo que aún falta ({left}) — el resto ya está pagado.' },

  // ── serviço (CDC: sempre removível) ─────────────────────────────────────
  'servico.label':    { en: 'Service charge ({pct}% of your share) — optional',
                        pt: 'Serviço da equipe ({pct}% da sua parte) — opcional',
                        es: 'Cargo por servicio ({pct}% de tu parte) — opcional' },

  // ── identificação ───────────────────────────────────────────────────────
  'payer.name':       { en: 'Your name (optional)',            pt: 'Seu nome (opcional)', es: 'Tu nombre (opcional)' },
  'payer.cpf':        { en: 'Your CPF (required to pay)',      pt: 'Seu CPF (obrigatório pra pagar)', es: 'Tu CPF (obligatorio para pagar)' },
  // O que o CPF é fica AQUI e não no placeholder: glosado no rótulo, o campo
  // truncava em "Your CPF, the Brazilian tax ID (required to" num telefone de
  // 430px — e um rótulo cortado explica menos que um curto. Visto no navegador.
  'payer.cpfWhy':     { en: 'CPF is the Brazilian tax ID. The payment provider asks for it to issue the charge — it goes to them, not to the restaurant, and Racha does not store it.',
                        pt: 'O provedor de pagamento pede o CPF pra emitir a cobrança. Vai pra ele, não pro restaurante, e a Racha não guarda.',
                        es: 'El CPF es el número fiscal brasileño. El proveedor de pago lo pide para emitir el cobro — va para él, no para el restaurante, y Racha no lo guarda.' },
  'payer.cpfHint':    { en: 'Enter your CPF, 11 digits, to enable payment.',
                        pt: 'Preencha seu CPF (11 dígitos) pra liberar o pagamento.',
                        es: 'Escribe tu CPF, 11 dígitos, para habilitar el pago.' },

  // ── pagar ───────────────────────────────────────────────────────────────
  // Uma chave por TRILHO: "Pay {amount} with Pix" numa mesa de Madrid é uma
  // promessa falsa, e colar o nome do trilho num buraco `{rail}` dá frases
  // torcidas em espanhol. O trilho vem do mercado, que vem do servidor.
  'pay.cta':          { en: 'Pay {amount} with Pix',           pt: 'Pagar {amount} com Pix', es: 'Pagar {amount} con Pix' },
  'pay.ctaBizum':     { en: 'Pay {amount} with Bizum',         pt: 'Pagar {amount} com Bizum', es: 'Pagar {amount} con Bizum' },
  'bizum.title':      { en: 'Pay with Bizum',                  pt: 'Pague com Bizum', es: 'Paga con Bizum' },
  'bizum.how':        { en: 'Confirm the payment in your bank’s app. It takes a few seconds.',
                        pt: 'Confirme o pagamento no app do seu banco. Leva alguns segundos.',
                        es: 'Confirma el pago en la app de tu banco. Tarda unos segundos.' },
  // A saída da tela de espera. NÃO diz "cancelado" nem "falhou": o pagamento
  // pode estar a caminho, e afirmar o contrário é o mesmo erro que a versão
  // anterior do `bizumStatus` cometia, de trás pra frente. Diz só o que se
  // sabe — que nada chegou ainda — e devolve o controle.
  // A frase de espera PROLONGADA substitui a de "alguns segundos", não se soma
  // a ela. A revisão de compliance foi específica: dizer "tarda unos segundos"
  // dois minutos depois é informação inexata, e a INEXATIDÃO é a infração —
  // CDC art. 6º III (informação clara e adequada) e, em Espanha, TRLGDCU art.
  // 60. Então a tela para de prometer e passa a dizer há quanto tempo espera.
  'bizum.stalled':    { en: 'Waiting for your bank for {mins} min.',
                        pt: 'Esperando seu banco há {mins} min.',
                        es: 'Esperando a tu banco desde hace {mins} min.' },
  'bizum.stalledHow': { en: 'If you cancelled in the app, go back and try again. If you approved it, the payment still lands on its own.',
                        pt: 'Se você cancelou no app, volte e tente de novo. Se aprovou, o pagamento cai sozinho.',
                        es: 'Si lo cancelaste en la app, vuelve e inténtalo otra vez. Si lo aprobaste, el pago llega solo.' },
  'bizum.backToBill': { en: 'Back to the bill',                pt: 'Voltar pra conta', es: 'Volver a la cuenta' },
  'bizum.waiting':    { en: 'Waiting for your bank… It takes a few seconds.',
                        pt: 'Esperando seu banco… Leva alguns segundos.',
                        es: 'Esperando a tu banco… Tarda unos segundos.' },
  'err.amount_under_min': { en: 'The minimum for this payment method is {min}.',
                        pt: 'O mínimo para este meio de pagamento é {min}.',
                        es: 'El mínimo para este método de pago es {min}.' },
  'err.amount_over_max': { en: 'The maximum for this payment method is {max}. Split the bill into smaller parts.',
                        pt: 'O máximo para este meio de pagamento é {max}. Divida a conta em partes menores.',
                        es: 'El máximo para este método de pago es {max}. Divide la cuenta en partes más pequeñas.' },
  'pay.retry':        { en: '{error} — the bill was refreshed, check the amount and try again.',
                        pt: '{error} — a conta foi atualizada, confira o valor e tente de novo.',
                        es: '{error} — la cuenta se actualizó, revisa el importe e inténtalo de nuevo.' },
  'pix.title':        { en: 'Pay with Pix',                    pt: 'Pague com Pix', es: 'Paga con Pix' },
  /**
   * "PARA A EQUIPE" prometia 100%, e a lei não entrega 100%.
   *
   * A Lei 13.419/2017 inseriu o CLT art. 457 §§3º-11, e o §6º permite ao
   * empregador RETER parte da gorjeta pros encargos sociais e previdenciários
   * — até 20% pra empresa no regime de tributação diferenciado, até 33% pras
   * demais. Então não dá pra afirmar que os {amount} chegam inteiros na equipe,
   * e por casa a gente nem sabe quanto chega.
   *
   * O que É verdade e o que resolve a frase: quem distribui é o restaurante, e
   * distribuir é obrigação legal dele (STJ Tema 1102 mantém a gorjeta fora da
   * receita da casa). Nomear o distribuidor mantém o destino visível sem virar
   * uma promessa de quantidade que o restaurante teria que honrar.
   * Achado pela revisão de compliance de 2026-09-10.
   */
  'pix.includesTip':  { en: 'includes {amount} service charge — the restaurant distributes it to the staff, as the law requires',
                        pt: 'inclui {amount} de serviço — o restaurante distribui à equipe, como manda a lei',
                        es: 'incluye {amount} de servicio — el restaurante lo distribuye al equipo, como exige la ley' },
  // A FOLHA DA CARTEIRA falava só português, no momento da AUTORIZAÇÃO.
  // `wallet.payWith` também vai no `aria-label` do diálogo.
  // O aviso do REEMBOLSO da conta-corrente, que o dono lê depois de registrar.
  // Era português cru dentro de um `setNotice` — e o censo não via, porque a
  // frase é interrompida por interpolação.
  'house.refundNotice': { en: 'Refund of {amount} recorded — send the Pix to the diner.',
                        pt: 'Reembolso de {amount} registrado — envie o Pix ao cliente.',
                        es: 'Reembolso de {amount} registrado — envía el Bizum al cliente.' },
  'house.refundBonus': { en: ' This account still has {amount} of active bonus.',
                        pt: ' Esta conta ainda tem {amount} de bônus ativo.',
                        es: ' Esta cuenta todavía tiene {amount} de bono activo.' },
  'wallet.payWith':   { en: 'Pay with {wallet}',                pt: 'Pagar com {wallet}', es: 'Pagar con {wallet}' },
  'wallet.authorizing': { en: 'authorising…',                   pt: 'autorizando…', es: 'autorizando…' },
  'wallet.payAmount': { en: 'Pay {amount}',                     pt: 'Pagar {amount}', es: 'Pagar {amount}' },
  'wallet.cancel':    { en: 'cancel',                           pt: 'cancelar', es: 'cancelar' },
  'pix.copy':         { en: 'Copy Pix code',                   pt: 'Copiar código Pix', es: 'Copiar código Pix' },
  'pix.copied':       { en: 'Code copied ✓',                   pt: 'Código copiado ✓', es: 'Código copiado ✓' },
  'pix.how':          { en: 'Open your bank app, choose Pix copy-and-paste and paste the code.',
                        pt: 'Abra o app do seu banco, escolha Pix copia-e-cola e cole o código.',
                        es: 'Abre la app de tu banco, elige Pix copiar y pegar y pega el código.' },
  'pix.aria':         { en: 'Pix copy and paste',              pt: 'Pix copia e cola', es: 'Pix copiar y pegar' },
  'pix.stillValid':   { en: 'no connection — the code below is still valid',
                        pt: 'sem conexão — o código abaixo continua valendo',
                        es: 'sin conexión — el código de abajo sigue siendo válido' },
  'pix.simulate':     { en: '✓ Simulate bank confirmation (demo)',
                        pt: '✓ Simular confirmação do banco (demo)',
                        es: '✓ Simular confirmación del banco (demo)' },
  'pix.simulating':   { en: 'confirming…',                     pt: 'confirmando…', es: 'confirmando…' },

  // ── pago ────────────────────────────────────────────────────────────────
  'paid.title':       { en: 'Payment confirmed',               pt: 'Pagamento confirmado', es: 'Pago confirmado' },
  'paid.thanks':      { en: 'Thanks, {name}! ',                pt: 'Valeu, {name}! ', es: '¡Gracias, {name}! ' },
  'paid.yours':       { en: 'Your share is paid.',             pt: 'Sua parte está paga.', es: 'Tu parte está pagada.' },
  'paid.progress':    { en: '{paid} of {total} paid',          pt: '{paid} de {total} pagos', es: '{paid} de {total} pagados' },
  'paid.left':        { en: ' — {left} to go',                 pt: ' — falta {left}', es: ' — faltan {left}' },
  'paid.closed':      { en: ' — bill closed 🎉',               pt: ' — conta fechada 🎉', es: ' — cuenta cerrada 🎉' },
  // Comprovante, NÃO fatura.
  //
  // Uma conta paga por várias pessoas não divide o IVA: a casa emite UMA fatura
  // simplificada da mesa, e o cliente mantém o direito à fatura completa com o
  // NIF dele (RD 1619/2012 em Espanha). Se esta tela parecer uma fatura, ela
  // promete um documento fiscal que não é — e puxaria a Racha pro escopo do
  // Verifactu / SIF (RD 1007/2023), uma obrigação bem maior pra entrar por
  // acidente. Então ela diz o que é: prova de pagamento, e onde pedir a fatura.
  // AVISOS DE DINHEIRO do próprio cliente (CDC art. 6º, III). O servidor manda
  // código + centavos; a frase e o formato do dinheiro nascem aqui, no idioma
  // de quem lê. Os dois casos são obrigação da casa, não cortesia: dinheiro
  // pago a mais tem que ser restituído (CC art. 876), e um estorno que falhou
  // deixa o cliente credor sem ele saber.
  // A frase fala da CONTA, não do leitor.
  //
  // Era "Você pagou {amount} a mais" — e os dois avisos nascem de estado da
  // CONTA (`state.overpaidCents`, qualquer anomalia de reversão na mesa),
  // mostrado no telefone de quem estiver olhando. Numa mesa de quatro em que
  // uma pessoa pagou a mais, os quatro telefones diziam "você tem a receber":
  // três estavam errados, num fluxo sem login onde o restaurante não tem como
  // saber qual deles é o credor. Convite pra alguém cobrar dinheiro de outro,
  // e a casa sem meio de recusar corretamente. CDC art. 6º III pede informação
  // CORRETA, não só clara.
  //
  // "a mais do que pedia" também cobre o caso em que a conta ENCOLHEU depois
  // do pagamento (um item estornado no POS): ninguém pagou a mais, a conta
  // diminuiu — e o dinheiro a devolver é o mesmo.
  'notice.overpaid_pending_restitution': { en: 'This bill received {amount} more than it asked. The restaurant owes that back — talk to the staff.',
                        pt: 'Esta conta recebeu {amount} a mais do que pedia. O restaurante deve devolver esse valor — fale com a equipe.',
                        es: 'Esta cuenta ha recibido {amount} de más. El restaurante debe devolver ese importe — habla con el personal.' },
  'notice.refund_reversed': { en: 'A refund of {amount} on this bill did not go through and went back to the restaurant. It is still owed — talk to the staff.',
                        pt: 'Um estorno de {amount} nesta conta não passou e voltou pro restaurante. Esse valor ainda é devido — fale com a equipe.',
                        es: 'Una devolución de {amount} en esta cuenta no se completó y volvió al restaurante. Ese importe sigue pendiente — habla con el personal.' },
  'paid.receipt':     { en: 'Proof of payment · {venue}',      pt: 'Comprovante de pagamento · {venue}', es: 'Justificante de pago · {venue}' },
  // O NOME do documento da casa, que vem do mercado: "CNPJ 12.345.678/0001-99"
  // e "NIF B12345678" são a mesma linha e não o mesmo rótulo. O valor é do
  // registro da casa e não se traduz, então a montagem "rótulo + valor" fica
  // no JSX — uma chave `'{label} {value}'` seria uma entrada de dicionário sem
  // uma palavra dentro, pedindo revisão de tradutor pra nada.
  //
  // A coluna existe desde a primeira migração, com o comentário "receipts must
  // show it", e a tela de pago nunca mostrou.
  'rcpt.taxIdCnpj':   { en: 'Tax ID (CNPJ)',                   pt: 'CNPJ', es: 'CNPJ' },
  'rcpt.taxIdNif':    { en: 'Tax ID (NIF)',                    pt: 'NIF', es: 'NIF' },
  // O QUE ELE PAGOU, no comprovante. A barra de progresso é da CONTA (consumo);
  // o comprovante tem que dizer o que saiu da conta DELE — e o serviço em
  // separado, porque é a parte que a casa distribui à equipe por obrigação
  // legal (Lei 13.419/2017), e que por isso tem que ser rastreável em linha
  // própria. Dizia "a parte que vai pra equipe" — a mesma afirmação que o
  // produto passou a semana tirando das telas, sobrevivendo no comentário
  // que explica por que a linha existe. Comentário é onde a próxima pessoa
  // aprende a lei.
  // A tela que aparece quando o render cai. Recarregar é seguro: a conta é
  // derivada do razão no servidor, nada mora só no navegador.
  'boundary.title':   { en: 'Something broke on this screen',   pt: 'Algo quebrou nesta tela', es: 'Algo se rompió en esta pantalla' },
  'boundary.body':    { en: 'Your bill is safe — it lives on the server, not here. Reloading picks it up where it was.',
                        pt: 'Sua conta está segura — ela vive no servidor, não aqui. Recarregar retoma de onde estava.',
                        es: 'Tu cuenta está a salvo — vive en el servidor, no aquí. Recargar retoma donde estaba.' },
  'boundary.retry':   { en: 'Reload',                           pt: 'Recarregar', es: 'Recargar' },
  'paid.youPaid':     { en: 'You paid {amount}',                pt: 'Você pagou {amount}', es: 'Pagaste {amount}' },
  // Mesma correção do `pix.includesTip`: nomeia o distribuidor, não promete a
  // quantidade. CLT art. 457 §6º permite retenção de 20% a 33% pros encargos.
  'paid.ofWhichTip':  { en: 'of which {amount} service charge — the restaurant distributes it to the staff, as the law requires',
                        pt: 'sendo {amount} de serviço — o restaurante distribui à equipe, como manda a lei',
                        es: 'de los cuales {amount} de servicio — el restaurante lo distribuye al equipo, como exige la ley' },
  // A VOLTA SEM TOKEN. Acontece quando o banco (ou o 3DS do cartão) devolve a
  // pessoa numa ABA NOVA, ou quando o navegador bloqueia armazenamento: o
  // `sessionStorage` da aba original não existe aqui. Antes disto a pessoa caía
  // na LANDING depois de ter autorizado o pagamento — nenhuma conta, nenhum
  // comprovante, nenhum "confirmando". A leitura razoável é que falhou, e a
  // ação razoável é pagar de novo. Achado da revisão de segurança de 2026-09-10.
  // "SE você acabou de pagar": esta tela também aparece pra quem só abriu
  // `/?r=1` sem ter pago nada, e ela não tem como conferir. Afirmar o
  // pagamento seria a página dizendo um fato que não checou.
  'ret.title':        { en: 'If you just paid, it is being confirmed',
                        pt: 'Se você acabou de pagar, está sendo confirmado',
                        es: 'Si acabas de pagar, se está confirmando' },
  'ret.body':         { en: 'Scan the table’s QR code again to see the bill — if the payment went through, it is already there. Do not pay twice.',
                        pt: 'Escaneie o QR da mesa de novo para ver a conta — se o pagamento passou, ele já está lá. Não pague duas vezes.',
                        es: 'Escanea otra vez el QR de la mesa para ver la cuenta — si el pago pasó, ya está ahí. No pagues dos veces.' },
  'paid.at':          { en: 'on {when}',                        pt: 'em {when}', es: 'el {when}' },
  'paid.notInvoice':  { en: 'This is not an invoice. Ask the restaurant for one if you need it.',
                        pt: 'Isto não é uma nota fiscal. Peça a nota ao restaurante se precisar.',
                        es: 'Esto no es una factura. Pídesela al restaurante si la necesitas.' },
  'paid.payMore':     { en: 'Pay another share',               pt: 'Pagar mais uma parte', es: 'Pagar otra parte' },

  // ── saldo da casa ───────────────────────────────────────────────────────
  'house.pay':        { en: 'Pay with balance ({amount} available)',
                        pt: 'Pagar com saldo ({amount} disponível)',
                        es: 'Pagar con saldo ({amount} disponible)' },
  'house.discover':   { en: 'Try the house balance',           pt: 'Conheça o saldo da casa', es: 'Prueba el saldo de la casa' },
  'house.bonus':      { en: 'Try the house balance — get {pct}% bonus',
                        pt: 'Conheça o saldo da casa — ganhe {pct}% de bônus',
                        es: 'Prueba el saldo de la casa — llévate un {pct}% extra' },

  // ── erros do servidor, por código ───────────────────────────────────────
  'err.check_not_found':  { en: 'Bill not found.',             pt: 'Conta não encontrada.', es: 'Cuenta no encontrada.' },
  'err.check_closed':     { en: 'This bill is already closed.', pt: 'Esta conta já foi fechada.', es: 'Esta cuenta ya está cerrada.' },
  'err.amount_over':      { en: 'Amount is more than what is left ({left}).',
                            pt: 'Valor acima do que falta ({left}).',
                        es: 'El importe supera lo que falta ({left}).' },
  'err.tax_id_invalid': { en: 'Check the document number.', pt: 'Confira o número do documento.', es: 'Revisa el número del documento.' },
  // O documento do recebedor tem que ser o MESMO que o recibo mostra: um é
  // onde o dinheiro liquida, o outro é o que o cliente lê. Divergir é o
  // comprovante dizer uma coisa e o split fazer outra.
  // O serviço só corre onde há CNPJ provado: sem pessoa jurídica não há folha,
  // e sem folha a frase "o restaurante distribui à equipe" seria falsa.
  'err.venue_no_tip_document': { en: 'This restaurant cannot take a service charge yet — its company document is not registered. You can still pay for what you ordered.',
                        pt: 'Este restaurante ainda não pode cobrar serviço — o CNPJ dele não está cadastrado. O consumo você pode pagar normalmente.',
                        es: 'Este restaurante todavía no puede cobrar servicio — su documento de empresa no está registrado. El consumo sí puedes pagarlo.' },
  'err.recipient_doc_mismatch': { en: 'This document is different from the one registered for the venue. They have to match — the receipt shows one and the money settles on the other.',
                        pt: 'Este documento é diferente do que está cadastrado no restaurante. Os dois têm que bater — o comprovante mostra um e o dinheiro liquida no outro.',
                        es: 'Este documento no coincide con el del restaurante. Tienen que ser el mismo — el recibo muestra uno y el dinero liquida en el otro.' },
  'err.market_not_live': { en: 'Payments are not enabled here yet.',
                        pt: 'Os pagamentos ainda não estão liberados aqui.',
                        es: 'Los pagos todavía no están habilitados aquí.' },
  // Erros do SALDO DA CASA e do cadastro da casa. Existiam como frases em
  // português sem código nenhum, então viajavam cruas pra qualquer leitor —
  // e uma delas ("venue has no settlement recipient configured") é a que o
  // próprio `http-error.js` cita como exemplo do que não pode sair.
  'err.venue_no_recipient': { en: 'This restaurant cannot take payments yet — please tell the staff.',
                        pt: 'Este restaurante ainda não consegue receber pagamentos — avise a equipe.',
                        es: 'Este restaurante todavía no puede cobrar — avisa al personal.' },
  'err.venue_not_found': { en: 'Restaurant not found.',        pt: 'Restaurante não encontrado.', es: 'Restaurante no encontrado.' },
  'err.house_off':    { en: 'This restaurant does not offer prepaid balance.',
                        pt: 'Este restaurante não oferece saldo pré-pago.',
                        es: 'Este restaurante no ofrece saldo prepago.' },
  'err.house_wrong_venue': { en: 'This balance is only good at the restaurant that issued it.',
                        pt: 'Este saldo vale somente no restaurante que o emitiu.',
                        es: 'Este saldo solo vale en el restaurante que lo emitió.' },
  // O limite chega em centavos e é formatado aqui, na moeda da casa: o
  // servidor escrevia `toFixed(2)`, sem moeda e sem idioma.
  'err.load_below_min': { en: 'The minimum top-up is {min}.',  pt: 'A recarga mínima é {min}.', es: 'La recarga mínima es {min}.' },
  'err.load_above_max': { en: 'The maximum top-up is {max}.',  pt: 'A recarga máxima é {max}.', es: 'La recarga máxima es {max}.' },
  'err.tip_not_supported': { en: 'This bill does not take a service charge.',
                        pt: 'Esta conta não aceita serviço.',
                        es: 'Esta cuenta no admite cargo por servicio.' },
  // Erro de CONFIGURAÇÃO, não do cliente: o PSP ligado nesta casa não emite na
  // moeda do mercado dela. A pessoa na mesa não pode fazer nada a respeito, e
  // por isso a frase não pede nada dela — manda chamar quem pode resolver.
  'err.psp_market_mismatch': { en: 'This restaurant cannot take payments right now. Please tell the staff.',
                        pt: 'Este restaurante não pode receber pagamentos agora. Avise a equipe.',
                        es: 'Este restaurante no puede cobrar ahora mismo. Avisa al personal.' },
  'err.rail_unsupported': { en: 'This payment method is not available here.',
                        pt: 'Este meio de pagamento não está disponível aqui.',
                        es: 'Este método de pago no está disponible aquí.' },
  'err.amount_invalid':   { en: 'Invalid amount.',             pt: 'Valor inválido.', es: 'Importe no válido.' },
  'err.zero_charge':      { en: 'Nothing to charge.',          pt: 'Cobrança de valor zero.', es: 'No hay nada que cobrar.' },
  'err.rate_limited':     { en: 'Too many attempts — wait a few minutes.',
                            pt: 'Muitas tentativas — aguarde alguns minutos.',
                        es: 'Demasiados intentos — espera unos minutos.' },
  'err.no_card':          { en: 'This restaurant does not take card yet.',
                            pt: 'Este restaurante ainda não aceita cartão.',
                        es: 'Este restaurante todavía no acepta tarjeta.' },
  // Erros de TRANSPORTE, não de dinheiro. Alcançáveis sem autenticação, então
  // precisam de frase — e a frase não acusa a pessoa de nada: um corpo grande
  // demais numa mesa é uma conexão ruim repetindo o envio, não um ataque.
  'err.body_too_large':   { en: 'That request was too large. Try again.',
                        pt: 'A requisição foi grande demais. Tente de novo.',
                        es: 'La solicitud fue demasiado grande. Inténtalo de nuevo.' },
  'err.body_incomplete':  { en: 'The connection dropped. Try again.',
                        pt: 'A conexão caiu. Tente de novo.',
                        es: 'Se cortó la conexión. Inténtalo de nuevo.' },
  // Erro da tela do DONO ao registrar que resolveu uma pendência: sem o
  // porquê, "resolvido" é só a marca sumindo do painel.
  'err.note_required':    { en: 'Say how it was resolved.',
                        pt: 'Diga como foi resolvido.',
                        es: 'Di cómo se resolvió.' },
  'err.event_invalid':    { en: 'That change does not fit this bill.',
                        pt: 'Essa mudança não cabe nesta conta.',
                        es: 'Ese cambio no encaja en esta cuenta.' },
  'err.resolve_failed':   { en: 'Could not record that. Try again.',
                        pt: 'Não deu pra registrar. Tente de novo.',
                        es: 'No se pudo registrar. Inténtalo de nuevo.' },
  'err.generic':          { en: 'Something went wrong. Try again.',
                            pt: 'Algo deu errado. Tente de novo.',
                        es: 'Algo ha ido mal. Inténtalo de nuevo.' },

  // ── landing (/) ─────────────────────────────────────────────────────────
  'home.how':         { en: 'How it works',                    pt: 'Como funciona', es: 'Cómo funciona' },
  'home.scan':        { en: 'Scan the QR on your table…',      pt: 'Escaneie o QR…', es: 'Escanea el QR de tu mesa…' },
  'home.forVenues':   { en: 'For restaurants and bars',        pt: 'Para restaurantes e bares', es: 'Para restaurantes y bares' },
  // O trilho do passo 3 tem uma chave POR TRILHO, não uma frase com "Pix"
  // dentro traduzida pra espanhol. A landing espanhola prometia Bizum no herói
  // e dizia "Pix directo a la cuenta del restaurante" duas linhas abaixo — a
  // mesma página se contradizendo, visto na tela em 2026-09-07.
  'home.bizumDirect': { en: 'Bizum straight into the restaurant’s account',
                        pt: 'Bizum direto na conta do restaurante',
                        es: 'Bizum directo a la cuenta del restaurante' },
  'home.pixDirect':   { en: 'Pix straight into the restaurant’s account',
                        pt: 'Pix direto na conta do restaurante',
                        es: 'Pix directo a la cuenta del restaurante' },
  'home.houseBalance':{ en: 'House balance',                   pt: 'Saldo da casa', es: 'Saldo de la casa' },

  // ── painel do restaurante ───────────────────────────────────────────────
  'panel.loading':    { en: 'loading the floor…',              pt: 'carregando o salão…', es: 'cargando la sala…' },
  'panel.activation': { en: 'Activation — last 7 days',        pt: 'Ativação — últimos 7 dias', es: 'Activación — últimos 7 días' },
  'panel.noMovement': { en: 'no movement in the last 7 days.', pt: 'sem movimento nos últimos 7 dias.', es: 'sin movimiento en los últimos 7 días.' },
  'panel.recon':      { en: 'Reconciliation',                  pt: 'Conciliação', es: 'Conciliación' },
  'panel.reconOk':    { en: 'Everything matches ✓ — {n} bills checked at {time}',
                        pt: 'Tudo bate ✓ — {n} contas conferidas às {time}',
                        es: 'Todo cuadra ✓ — {n} cuentas revisadas a las {time}' },
  'panel.reconDrift': { en: 'Mismatch between the ledger and the payments.',
                        pt: 'Divergência entre o registro e os pagamentos.',
                        es: 'Descuadre entre el registro y los pagos.' },
  'panel.reconManual':{ en: 'This does not fix itself, on purpose.',
                        pt: 'Isso não corrige sozinho, de propósito.',
                        es: 'Esto no se corrige solo, a propósito.' },
  'panel.noAnomaly':  { en: 'no anomalies ✓',                  pt: 'nenhuma anomalia ✓', es: 'sin anomalías ✓' },
  'panel.anomalies':  { en: 'anomalies — reconcile!',          pt: 'anomalias — conciliar!', es: 'anomalías — ¡conciliar!' },
  'panel.reconDriftAmt': { en: '{amount} of difference between what the app recorded and what was paid.',
                        pt: '{amount} de diferença entre o que o app registrou e o que foi pago.',
                        es: '{amount} de diferencia entre lo que la app registró y lo que se pagó.' },
  'panel.reconCall':  { en: 'Talk to us before you close the till.',
                        pt: 'Fale com a gente antes de fechar o caixa.',
                        es: 'Habla con nosotros antes de cerrar la caja.' },
  // A taxa de chargeback é o número pelo qual o ADQUIRENTE julga a casa — acima
  // de um patamar a bandeira aplica programa de monitoramento. O razão já sabia
  // o desfecho de cada disputa e nada mostrava isso pro dono.
  'panel.disputes':   { en: 'chargebacks',                     pt: 'chargebacks', es: 'contracargos' },
  'panel.disputesOpen': { en: '{n} open',                      pt: '{n} em aberto', es: '{n} abiertos' },
  'panel.tip':        { en: 'service charge (payroll)',        pt: 'serviço da equipe (folha)', es: 'cargo por servicio (nómina)' },
  // SERVIÇO COBRADO vs ARRECADADO, e o dinheiro a devolver. As duas linhas
  // existem porque duas regras favorecem a casa e não podem ficar invisíveis:
  // num Pix pago a menor o serviço é o resíduo (quem digita menos está
  // recusando a linha opcional), e o excedente de quem paga a mais não é
  // receita — é dívida (CC art. 876). Uma diferença que aparece é um fato do
  // negócio; a mesma diferença escondida é uma reclamação trabalhista.
  'panel.tipShort':   { en: 'of {charged} charged',              pt: 'de {charged} cobrados', es: 'de {charged} cobrados' },
  // A dívida na linha da MESA, e a cobrança que a paga. O aviso ao cliente
  // manda falar com a equipe; a tela da equipe precisa saber de qual mesa e de
  // qual cobrança se trata, senão a instrução não é executável.
  // Erros da rota de restituição manual (`/api/checks/record-restitution`).
  'err.reference_required': { en: 'Enter the refund reference — it is what proves the refund if the diner disputes it.',
                        pt: 'Informe a referência da devolução — é o que prova o reembolso se o cliente contestar.',
                        es: 'Indica la referencia de la devolución — es lo que prueba el reembolso si el cliente lo disputa.' },
  'err.restitution_failed': { en: 'Could not record the refund. Check the amount and try again.',
                        pt: 'Não foi possível registrar a devolução. Confira o valor e tente de novo.',
                        es: 'No se pudo registrar la devolución. Revisa el importe e inténtalo de nuevo.' },
  'err.nothing_to_restitute': { en: 'This charge has no excess to give back. Use a refund through the acquirer instead.',
                        pt: 'Esta cobrança não tem excedente a restituir. Use o estorno pelo adquirente.',
                        es: 'Este cobro no tiene exceso que devolver. Usa la devolución por el adquirente.' },
  'err.txid_unknown': { en: 'That charge is not on this bill.',
                        pt: 'Essa cobrança não é desta conta.',
                        es: 'Ese cobro no es de esta cuenta.' },
  /**
   * OS ACHADOS DA CONCILIAÇÃO, traduzidos.
   *
   * O painel do dono imprimia `f.message` — texto em PORTUGUÊS montado no
   * servidor, com centavos crus (`9000¢`). Contra o acordo de trabalho: o
   * servidor manda código estável + centavos, o cliente traduz e formata. A
   * tela do CLIENTE ganhou esse tratamento (`NOTICE_KEY`); a do dono era o
   * chamador esquecido. Achado pela revisão de segurança de 2026-09-08.
   */
  'find.overpaid_pending_restitution': { en: 'received {amount} more than the bill asked — refund pending',
                        pt: 'recebeu {amount} a mais do que a conta pedia — devolução pendente',
                        es: 'ha recibido {amount} de más — devolución pendiente' },
  'find.ledger_drift':{ en: 'the two money records disagree by {amount}',
                        pt: 'os dois registros de dinheiro divergem em {amount}',
                        es: 'los dos registros de dinero difieren en {amount}' },
  'find.amount_mismatch': { en: 'confirmed amount does not match the ledger',
                        pt: 'valor confirmado não bate com o razão',
                        es: 'el importe confirmado no coincide con el libro' },
  'find.tip_mismatch':{ en: 'confirmed service charge does not match the ledger',
                        pt: 'serviço confirmado não bate com o razão',
                        es: 'el cargo por servicio confirmado no coincide con el libro' },
  'find.refund_mismatch': { en: 'refunded amount does not match the ledger',
                        pt: 'valor estornado não bate com o razão',
                        es: 'el importe devuelto no coincide con el libro' },
  'find.status_lag':  { en: 'the payment row is behind the ledger',
                        pt: 'a linha do pagamento está atrasada em relação ao razão',
                        es: 'la fila del pago está por detrás del libro' },
  'find.missing_payment_row': { en: 'the ledger has a payment with no row',
                        pt: 'o razão tem um pagamento sem linha',
                        es: 'el libro tiene un pago sin fila' },
  'find.missing_log_event': { en: 'a confirmed payment is missing from the ledger',
                        pt: 'um pagamento confirmado não está no razão',
                        es: 'falta un pago confirmado en el libro' },
  'find.log_anomaly': { en: 'the ledger flagged something on this bill',
                        pt: 'o razão marcou algo nesta conta',
                        es: 'el libro ha marcado algo en esta cuenta' },
  'find.service_never_collected': { en: 'service charged on every bill and none collected — check the amount reading',
                        pt: 'serviço cobrado em todas as contas e nada arrecadado — conferir a leitura do valor',
                        es: 'servicio cobrado en todas las cuentas y nada recaudado — revisar la lectura del importe' },
  'find.underpayment': { en: 'paid {amount} less than the bill asked',
                        pt: 'pago {amount} a menos do que a conta pedia',
                        es: 'pagado {amount} menos de lo que pedía la cuenta' },
  'find.overpayment': { en: 'paid {amount} more than the bill asked',
                        pt: 'pago {amount} a mais do que a conta pedia',
                        es: 'pagado {amount} más de lo que pedía la cuenta' },
  // A TERCEIRA PERNA: o razão do adquirente. `custody_leak` é o único achado
  // desta lista que não é "um número divergiu" — é dinheiro fora da subconta do
  // restaurante, o que muda o perímetro regulatório da Racha (inegociável #4,
  // BACEN Res. 494/2025). Ver `docs/runbooks/custodia-do-excedente.md`.
  'find.custody_leak': { en: '{amount} of this charge went to an account that is not the restaurant’s — money outside the venue’s subaccount',
                        pt: '{amount} desta cobrança foram para uma conta que não é a do restaurante — dinheiro fora da subconta da casa',
                        es: '{amount} de este cobro fueron a una cuenta que no es la del restaurante — dinero fuera de la subcuenta del local' },
  'find.payable_amount_mismatch': { en: 'the acquirer paid the restaurant {amount} less than the charge captured',
                        pt: 'o adquirente repassou {amount} menos do que a cobrança capturou',
                        es: 'el adquirente abonó {amount} menos de lo que capturó el cobro' },
  'find.payable_net_negative': { en: 'the acquirer’s fee exceeded the receivable — the net is negative',
                        pt: 'a taxa do adquirente passou do recebível — o líquido ficou negativo',
                        es: 'la comisión del adquirente superó el abono — el neto es negativo' },
  'find.payable_no_recipient_field': { en: 'a receivable has no recipient — the destination cannot be named',
                        pt: 'um recebível está sem recebedor — não dá pra nomear o destino',
                        es: 'un abono no tiene receptor — no se puede nombrar el destino' },
  'find.payable_type_unknown': { en: 'the acquirer sent a receivable type we do not know — unclear if it moves money',
                        pt: 'o adquirente mandou um tipo de recebível que não conhecemos — não sei se move dinheiro',
                        es: 'el adquirente envió un tipo de abono desconocido — no se sabe si mueve dinero' },
  'find.payables_never_verified': { en: 'charges were considered and none could be verified — the destination check is not working',
                        pt: 'cobranças foram consideradas e nenhuma pôde ser verificada — a conferência de destino não está funcionando',
                        es: 'se consideraron cobros y ninguno pudo verificarse — la verificación de destino no funciona' },
  'find.payables_leg_disabled': { en: 'the money-destination check is switched OFF — nobody is verifying where charges settle',
                        pt: 'a conferência de destino do dinheiro está DESLIGADA — ninguém está verificando onde as cobranças caem',
                        es: 'la verificación del destino del dinero está DESACTIVADA — nadie comprueba dónde caen los cobros' },
  // O REPARO DE LINHA, dito pra quem lê o painel. A conciliação escreve em
  // `payments` quando a projeção ficou atrás do razão, e um reparo sem nome na
  // tela é uma escrita de dinheiro que só o JSON do cron conhece.
  'find.payment_row_repaired': { en: 'we corrected payment rows that were showing outdated amounts — your revenue totals for the affected days may have changed',
                        pt: 'corrigimos linhas de pagamento que mostravam valores desatualizados — o faturamento dos dias afetados pode ter mudado',
                        es: 'corregimos filas de pago que mostraban importes desactualizados — la facturación de esos días puede haber cambiado' },
  // RECUSADO pelo banco: afirmação FIRME, nada foi escrito.
  // "ATRÁS DO RAZÃO" LIA AO CONTRÁRIO — e ao contrário na direção que custa.
  //
  // Três descrições da MESMA condição diziam coisas diferentes: o achado do
  // servidor dizia que a base exibida está ACIMA do razão, o runbook idem, e
  // esta — a única que o dono lê — dizia "o que você vê segue atrás do razão".
  // A leitura natural de "está atrás" é "o número vai SUBIR", que é a direção
  // que produz distribuição a mais, e o CLT art. 462 não deixa descontar isso
  // depois. O irmão `ack_lost` logo abaixo já acertava.
  'find.payment_row_repair_rejected': { en: 'the database refused to correct some payment rows — nothing was written, so the service-charge figures you see are HIGHER than the ledger. The ledger figure is the safe one to distribute on; resolve this before closing the period',
                        pt: 'o banco recusou a correção de algumas linhas de pagamento — nada foi escrito, então os valores de serviço que você vê estão ACIMA do razão. O valor do razão é o seguro para distribuir; resolva isso antes de fechar o período',
                        es: 'la base rechazó corregir algunas filas de pago — no se escribió nada, así que los importes de servicio que ve están POR ENCIMA del libro. El importe del libro es el seguro para distribuir; resuélvalo antes de cerrar el período' },
  // NÃO SEI SE ESCREVEU. A RPC pode ter dado commit com a resposta perdida —
  // dizer "falhou" seria uma afirmação falsa na direção contrária, e mandaria o
  // dono caçar um travamento que não existe.
  // A DÚVIDA É DE UM LADO SÓ, e o lado seguro tem nome.
  //
  // O reparo só entra numa linha ATRÁS do razão nas pernas de estorno, então
  // ele só pode AUMENTAR `refunded_tip_cents` — ou seja, só pode DIMINUIR a
  // base da folha. Nunca é "subiu ou desceu": é "o número exibido já alcançou
  // ou não". E os dois erros não são simétricos: distribuir pelo número ANTIGO
  // (maior) e estar errado é distribuição a mais, que o CLT art. 462 proíbe
  // descontar depois — o dinheiro foi. Distribuir pelo do RAZÃO (menor) e estar
  // errado se conserta com um complemento no período seguinte. Então a
  // mensagem nomeia o lado seguro, em vez de devolver a dúvida crua.
  'find.payment_repair_ack_lost': { en: 'we tried to correct payment rows and got no answer from the database — the correction may or may not have been applied. The ledger figure is the lower one and it is the safe one to distribute on; check these payments before closing the period',
                        pt: 'tentamos corrigir linhas de pagamento e não tivemos resposta do banco — a correção pode ou não ter sido aplicada. O valor do razão é o menor e é o seguro para distribuir; confira esses pagamentos antes de fechar o período',
                        es: 'intentamos corregir filas de pago y no hubo respuesta de la base — la corrección puede haberse aplicado o no. El importe del libro es el menor y es el seguro para distribuir; revise esos pagos antes de cerrar el período' },
  // A GORJETA tem a sua própria: é a única que a casa leva pra FOLHA, e uma vez
  // distribuída não volta (CLT art. 462). Ver `payment_tip_base_repaired`.
  'find.payment_row_repair_raced': { en: 'a correction did not apply because another process had already updated the row — nothing was lost',
                        pt: 'uma correção não pegou porque outro processo já tinha atualizado a linha — nada se perdeu',
                        es: 'una corrección no se aplicó porque otro proceso ya había actualizado la fila — no se perdió nada' },
  // CONFIRMADA SEM DATA: some do faturamento, da gorjeta e da conferência de
  // destino, e o painel filtra por essa coluna.
  'find.confirmed_at_missing': { en: 'a confirmed payment has no confirmation date — it is missing from your revenue, your service-charge totals and the destination check',
                        pt: 'um pagamento confirmado está sem data de confirmação — ele fica fora do faturamento, do total de serviço e da conferência de destino',
                        es: 'un pago confirmado no tiene fecha de confirmación — queda fuera de la facturación, del total de servicio y de la verificación de destino' },
  'find.payment_tip_base_repaired': { en: 'we corrected the service-charge figures on some payments — check them before closing payroll for the period',
                        pt: 'corrigimos os valores de serviço de alguns pagamentos — confira antes de fechar a folha do período',
                        es: 'corregimos los importes de servicio de algunos pagos — revíselos antes de cerrar la nómina del período' },
  'find.payment_rows_unrepaired': { en: 'some payment rows were not even examined (sweep deadline or repair cap)',
                        pt: 'algumas linhas de pagamento não foram nem olhadas (prazo da varredura ou teto de reparos)',
                        es: 'algunas filas de pago no se revisaron (plazo del barrido o tope de reparaciones)' },
  'find.payable_shape_invalid': { en: 'the acquirer sent a receivable with an unreadable amount — the destination could not be verified for this charge',
                        pt: 'o adquirente mandou um recebível com valor ilegível — não deu pra conferir o destino desta cobrança',
                        es: 'el adquirente envió un abono con importe ilegible — no se pudo verificar el destino de este cobro' },
  // NÃO SEI QUANTO, SEI PRA QUEM. Custódia se decide pelo destino.
  'find.custody_leak_unreadable': { en: 'part of this charge settled to a recipient that is not this venue — the amount is unreadable, the destination is not',
                        pt: 'parte desta cobrança caiu num recebedor que não é esta casa — o valor está ilegível, o destino não',
                        es: 'parte de este cobro fue a un receptor que no es este local — el importe es ilegible, el destino no' },
  'find.payables_absent': { en: 'the acquirer has no receivable for this charge yet — destination not verified',
                        pt: 'o adquirente ainda não tem recebível desta cobrança — destino não conferido',
                        es: 'el adquirente aún no tiene el abono de este cobro — destino sin verificar' },
  // DINHEIRO ANDOU E NÃO DÁ PRA DIZER PRA ONDE. Inegociável #4.
  // DUAS condições, uma string: recebedor inutilizável (de teste, recusado,
  // suspenso) OU ausente. A primeira versão dizia só "placeholder de teste", e
  // pra casa SEM recebedor nenhum a única frase que o dono lia era falsa — e
  // apontava pra "troque o placeholder" quando a ação é "não há conta de
  // repasse". Mesma forma do MEDIUM-H, uma condição depois.
  'find.venue_recipient_unusable': { en: 'this venue took confirmed payments but has no usable payout account — the acquirer cannot confirm that destination, so where the money went cannot be verified',
                        pt: 'esta casa recebeu pagamentos confirmados mas não tem conta de repasse utilizável — o adquirente não confirma esse destino, então não dá pra conferir pra onde o dinheiro foi',
                        es: 'este local recibió pagos confirmados pero no tiene cuenta de abono utilizable — el adquirente no confirma ese destino, así que no se puede verificar adónde fue el dinero' },
  'find.test_venue_with_live_recipient': { en: 'venues flagged as test have real payout accounts — they can receive real money and no reconciliation runs on them',
                        pt: 'casas marcadas como teste têm conta de repasse de verdade — elas podem receber dinheiro real e nenhuma conciliação roda nelas',
                        es: 'locales marcados como prueba tienen cuentas de abono reales — pueden recibir dinero real y ninguna conciliación se ejecuta sobre ellos' },
  // NÃO É "AINDA": essa cobrança nunca passou por adquirente nenhum.
  'find.charge_not_from_acquirer': { en: 'this charge did not go through the acquirer, so there is no settlement record to check — its destination cannot be verified here',
                        pt: 'esta cobrança não passou pelo adquirente, então não há registro de repasse a conferir — o destino dela não é conferível por aqui',
                        es: 'este cobro no pasó por el adquirente, así que no hay registro de abono que revisar — su destino no se puede verificar aquí' },
  'find.payables_venue_shape_unknown': { en: 'the reconciliation was handed an incomplete venue record — nothing can be asserted about where this venue\u2019s money goes',
                        pt: 'a conciliação recebeu um registro de casa incompleto — não dá pra afirmar nada sobre o destino do dinheiro dela',
                        es: 'la conciliación recibió un registro de local incompleto — no se puede afirmar nada sobre el destino de su dinero' },
  'find.payables_no_recipient': { en: 'this venue has no known acquirer recipient — the destination cannot be checked',
                        pt: 'esta casa não tem recebedor conhecido no adquirente — não dá pra conferir o destino',
                        es: 'este local no tiene receptor conocido en el adquirente — no se puede verificar el destino' },
  'find.payables_unchecked': { en: 'could not read the acquirer’s receivables this time',
                        pt: 'não deu pra ler os recebíveis do adquirente nesta passada',
                        es: 'no se pudieron leer los abonos del adquirente esta vez' },
  'find.confirmed_amount_missing': { en: 'a confirmed payment has no confirmed amount recorded',
                        pt: 'um pagamento confirmado está sem o valor confirmado gravado',
                        es: 'un pago confirmado no tiene el importe confirmado registrado' },
  // Conta-corrente da casa (saldo pré-pago). Achados que já existiam e que
  // ninguém traduzia — o censo só os viu depois de aprender a forma
  // posicional do `add()`.
  'find.house_lot_drift': { en: 'a balance lot does not match the ledger',
                        pt: 'um lote de saldo não bate com o razão',
                        es: 'un lote de saldo no coincide con el libro' },
  'find.house_lot_missing': { en: 'a balance lot in the ledger has no stored counterpart',
                        pt: 'um lote do razão não tem contrapartida gravada',
                        es: 'un lote del libro no tiene contrapartida guardada' },
  'find.house_lot_unknown': { en: 'a stored balance lot is absent from the ledger',
                        pt: 'um lote gravado não está no razão',
                        es: 'un lote guardado no está en el libro' },
  'find.house_principal_drift': { en: 'the wallet principal does not match the ledger',
                        pt: 'o principal da carteira não bate com o razão',
                        es: 'el principal del monedero no coincide con el libro' },
  'find.house_log_anomaly': { en: 'the wallet ledger flagged something',
                        pt: 'o razão da carteira marcou algo',
                        es: 'el libro del monedero ha marcado algo' },
  'find.house_reduce_threw': { en: 'the wallet ledger could not be read — worse than known drift',
                        pt: 'não deu pra ler o razão da carteira — pior que divergência conhecida',
                        es: 'no se pudo leer el libro del monedero — peor que una diferencia conocida' },
  'find.reduce_threw': { en: 'this bill’s ledger could not be read — worse than known drift',
                        pt: 'não deu pra ler o razão desta conta — pior que divergência conhecida',
                        es: 'no se pudo leer el libro de esta cuenta — peor que una diferencia conocida' },
  'find.other':       { en: 'needs a look: {code}',
                        pt: 'precisa de atenção: {code}',
                        es: 'necesita atención: {code}' },
  'panel.owedBack':   { en: 'owed back: {amount}',               pt: 'a devolver: {amount}', es: 'a devolver: {amount}' },
  'panel.toRefund':   { en: 'to refund to diners',               pt: 'a devolver a clientes', es: 'a devolver a clientes' },
  'panel.receivedToday': { en: 'received today · {n} payments', pt: 'recebido hoje · {n} pagamentos', es: 'recibido hoy · {n} pagos' },
  'panel.tables':     { en: 'Tables',                          pt: 'Mesas', es: 'Mesas' },
  'panel.noOpenBill': { en: 'no open bills.',                  pt: 'nenhuma conta aberta.', es: 'no hay cuentas abiertas.' },
  'panel.autoRefresh':{ en: 'racha · the panel refreshes itself every 4s',
                        pt: 'racha · painel atualiza sozinho a cada 4s',
                        es: 'racha · el panel se actualiza solo cada 4s' },
  'panel.reconOkFull':{ en: 'Everything matches ✓',            pt: 'Tudo bate ✓', es: 'Todo cuadra ✓' },
  'panel.reconChecked': { en: '— {bills}{accounts} at {time}',
                        pt: '— {bills}{accounts} às {time}',
                        es: '— {bills}{accounts} a las {time}' },
  'panel.billsOne':   { en: '1 bill checked',                  pt: '1 conta conferida', es: '1 cuenta revisada' },
  'panel.billsMany':  { en: '{n} bills checked',               pt: '{n} contas conferidas', es: '{n} cuentas revisadas' },
  'panel.balOne':     { en: ', 1 balance',                     pt: ', 1 saldo', es: ', 1 saldo' },
  'panel.balMany':    { en: ', {n} balances',                  pt: ', {n} saldos', es: ', {n} saldos' },
  'panel.methods':    { en: 'Pix {pix} · Card {card} · Balance {house}',
                        pt: 'Pix {pix} · Cartão {card} · Saldo {house}',
                        es: 'Pix {pix} · Tarjeta {card} · Saldo {house}' },
  'panel.weekLine':   { en: 'Week: {payments} · {bills} · {amount} · service charge {tip}',
                        pt: 'Semana: {payments} · {bills} · {amount} · serviço {tip}',
                        es: 'Semana: {payments} · {bills} · {amount} · servicio {tip}' },
  'panel.nPayments':  { en: '{n} payments',                    pt: '{n} pagamentos', es: '{n} pagos' },
  'panel.onePayment': { en: '1 payment',                       pt: '1 pagamento', es: '1 pago' },
  'panel.nBills':     { en: '{n} bills',                       pt: '{n} contas', es: '{n} cuentas' },
  'panel.oneBill':    { en: '1 bill',                          pt: '1 conta', es: '1 cuenta' },
  'panel.status.aberta':  { en: 'open',    pt: 'aberta', es: 'abierta' },
  'panel.status.parcial': { en: 'paying',  pt: 'pagando', es: 'pagando' },
  'panel.status.paga':    { en: 'paid',    pt: 'paga', es: 'pagada' },
  'panel.status.fechada': { en: 'closed',  pt: 'fechada', es: 'cerrada' },

  // ── carteira ────────────────────────────────────────────────────────────
  'wallet.header':    { en: 'wallet',                          pt: 'carteira', es: 'monedero' },
  'common.signOut':   { en: 'sign out',                        pt: 'sair', es: 'salir' },
  'wallet.open':      { en: 'Open your wallet',                pt: 'Abrir sua carteira', es: 'Abre tu monedero' },
  'wallet.create':    { en: 'Create wallet',                   pt: 'Criar carteira', es: 'Crear monedero' },
  'wallet.yourName':  { en: 'Your name',                       pt: 'Seu nome', es: 'Tu nombre' },
  'wallet.phone':     { en: 'Phone with area code (digits only)',
                        pt: 'Telefone com DDD (só números)',
                        es: 'Teléfono con prefijo (solo números)' },
  'wallet.balance':   { en: 'Your balance',                    pt: 'Seu saldo', es: 'Tu saldo' },
  'wallet.topUp':     { en: 'Top up balance',                  pt: 'Carregar saldo', es: 'Recargar saldo' },
  'wallet.topUpPix':  { en: 'Top up with Pix',                 pt: 'Carregar com Pix', es: 'Recargar con Pix' },
  'wallet.creating':  { en: 'creating…',                       pt: 'criando…', es: 'creando…' },
  'wallet.pitch':     { en: 'Top up by Pix and pay the bill straight from your phone.',
                        pt: 'Carregue saldo por Pix e pague a conta direto do celular.',
                        es: 'Recarga saldo por Pix y paga la cuenta desde el móvil.' },
  'wallet.paidBal':   { en: 'Paid balance',                    pt: 'Saldo pago', es: 'Saldo pagado' },
  'wallet.bonus':     { en: 'Promotional bonus',               pt: 'Bônus promocional', es: 'Bono promocional' },
  'wallet.refundable':{ en: 'Paid balance never expires and is refundable.',
                        pt: 'Saldo pago não expira e é reembolsável.',
                        es: 'El saldo pagado no caduca y es reembolsable.' },
  'wallet.noMoves':   { en: 'no activity yet.',                pt: 'nenhuma movimentação ainda.', es: 'todavía sin movimientos.' },
  'wallet.exists':    { en: 'Account already exists — ask for your link at the counter',
                        pt: 'Conta já existe — peça seu link no balcão',
                        es: 'La cuenta ya existe — pide tu enlace en la barra' },
  'wallet.badLink':   { en: 'Invalid link — ask for a new one at the counter.',
                        pt: 'Link inválido — peça um novo no balcão.',
                        es: 'Enlace no válido — pide uno nuevo en la barra.' },
  'wallet.atTable':   { en: 'Pay at the table',                pt: 'Pagamento na mesa', es: 'Pago en la mesa' },

  // ── pagar com saldo ─────────────────────────────────────────────────────
  'housepay.cta':     { en: 'Pay with balance',                pt: 'Pagar com saldo', es: 'Pagar con saldo' },
  'housepay.done':    { en: 'Paid with balance',               pt: 'Pago com saldo', es: 'Pagado con saldo' },
  'housepay.available': { en: '{amount} available in your wallet',
                        pt: '{amount} disponível na sua carteira', es: '{amount} disponible en tu cartera' },
  'housepay.paying':  { en: 'paying…',                          pt: 'pagando…', es: 'pagando…' },
  'housepay.payAmount': { en: 'Pay {amount} with balance',      pt: 'Pagar {amount} com saldo', es: 'Pagar {amount} con saldo' },
  // O comprovante do saldo: bônus e principal saem separados porque são
  // dinheiros diferentes — um foi pago pelo cliente, o outro foi promoção.
  'housepay.usedBonus': { en: '{amount} from the bonus',        pt: '{amount} do bônus', es: '{amount} del bono' },
  'housepay.usedPaid': { en: '{amount} from the paid balance',  pt: '{amount} do saldo pago', es: '{amount} del saldo pagado' },
  'housepay.tipApart':{ en: 'The service charge goes separately, by Pix.',
                        pt: 'O serviço da equipe (gorjeta) vai separado, pelo Pix.',
                        es: 'El cargo por servicio va aparte, por Pix.' },

  // ── carteiras de cartão ─────────────────────────────────────────────────
  'card.gpayOut':     { en: 'Google Pay unavailable',          pt: 'Google Pay indisponível', es: 'Google Pay no disponible' },
  'card.gpayFail':    { en: 'could not load Google Pay',       pt: 'não deu para carregar o Google Pay', es: 'no se ha podido cargar Google Pay' },
  'card.demoNote':    { en: 'simulation (demo) — no real charge is made',
                        pt: 'simulação (demo) — nenhuma cobrança real é feita',
                        es: 'simulación (demo) — no se realiza ningún cobro real' },
  'card.validateFail':{ en: 'could not validate the payment',  pt: 'não deu para validar o pagamento', es: 'no se ha podido validar el pago' },
  'card.incomplete':  { en: 'payment not completed',           pt: 'pagamento não concluído', es: 'pago no completado' },
  'card.word':        { en: 'card',                            pt: 'cartão', es: 'tarjeta' },

  // ── login do restaurante ────────────────────────────────────────────────
  'gate.title':       { en: 'racha · restaurant area',         pt: 'racha · área do restaurante', es: 'racha · área del restaurante' },
  'gate.signUp':      { en: 'Create account',                  pt: 'Criar conta', es: 'Crear cuenta' },
  'gate.haveAccount': { en: 'I already have an account',       pt: 'Já tenho conta', es: 'Ya tengo cuenta' },
  'gate.forgot':      { en: 'Forgot password',                 pt: 'Esqueci a senha', es: 'He olvidado la contraseña' },
  'gate.emailFirst':  { en: 'Type your e-mail first.',         pt: 'Digite seu e-mail primeiro.', es: 'Escribe tu correo primero.' },
  'gate.resetSent':   { en: 'We sent a reset link to your e-mail.',
                        pt: 'Enviamos um link de redefinição pro seu e-mail.',
                        es: 'Te hemos enviado un enlace de restablecimiento al correo.' },
  'gate.created':     { en: 'Account created! Check your e-mail to confirm, then sign in.',
                        pt: 'Conta criada! Confira seu e-mail pra confirmar e depois entre.',
                        es: '¡Cuenta creada! Revisa tu correo para confirmar y luego entra.' },

  // ── cartões de QR ───────────────────────────────────────────────────────
  'qr.scanToPay':     { en: 'Scan to see the bill, split it and pay by Pix',
                        pt: 'Escaneie para ver a conta, dividir e pagar no Pix',
                        es: 'Escanea para ver la cuenta, dividirla y pagar' },
  'qr.sheetNote':     { en: 'racha · one card per table, 2 per A4 sheet',
                        pt: 'racha · um cartão por mesa, 2 por folha A4',
                        es: 'racha · una tarjeta por mesa, 2 por hoja A4' },

  // ── landing, texto de venda ─────────────────────────────────────────────
  'home.tagline':     { en: 'pay at the table',                pt: 'pagamento na mesa', es: 'pago en la mesa' },
  'home.h1':          { en: 'The table’s bill, settled on Pix.',
                        pt: 'A conta da mesa, resolvida no Pix.',
                        es: 'La cuenta de la mesa, resuelta en un momento.' },
  'home.lede':        { en: 'Your guest scans the QR, splits it however they like and pays in seconds — no app, no sign-up, no waiting for the card machine. Card via Google\u00a0Pay and prepaid balance with bonus, on the same QR.',
                        pt: 'O cliente escaneia o QR, divide como quiser e paga em segundos — sem app, sem cadastro, sem esperar a maquininha. Cartão via Google\u00a0Pay e saldo pré-pago com bônus, no mesmo QR.',
                        es: 'El cliente escanea el QR, la divide como quiera y paga en segundos — sin app, sin registro, sin esperar el datáfono. Tarjeta vía Google Pay y saldo prepago con bono, en el mismo QR.' },
  'home.demo':        { en: 'See the live demo',               pt: 'Ver a demonstração ao vivo', es: 'Ver la demo en directo' },
  'home.iAmVenue':    { en: 'I’m a restaurant — go to the panel',
                        pt: 'Sou restaurante — entrar no painel',
                        es: 'Tengo un restaurante — entrar al panel' },
  'home.step1':       { en: '1 · Scanned',                     pt: '1 · Escaneou', es: '1 · Escaneó' },
  'home.step1d':      { en: 'the table QR opens the bill right away',
                        pt: 'o QR da mesa abre a conta na hora',
                        es: 'el QR de la mesa abre la cuenta al instante' },
  'home.step2':       { en: '2 · Split',                       pt: '2 · Dividiu', es: '2 · Dividió' },
  'home.step2d':      { en: 'equally or by amount — each pays their own share',
                        pt: 'igual ou por valor — cada um a sua parte',
                        es: 'por igual o por importe — cada uno paga su parte' },
  'home.step3':       { en: '3 · Paid',                        pt: '3 · Pagou', es: '3 · Pagó' },
  'home.legal':       { en: 'The service charge is tracked separately, the way the law requires. The table turns faster at the rush — and nobody waits for a card machine passed hand to hand.',
                        pt: 'Serviço da equipe (gorjeta) rastreado separado, do jeito que a lei pede. A mesa gira mais rápido no rush — e ninguém fica esperando maquininha passar de mão em mão.',
                        es: 'El cargo por servicio se registra aparte, como pide la ley. La mesa rota más rápido en hora punta — y nadie espera a que el datáfono pase de mano en mano.' },
  'home.balancePitch':{ en: 'Your guest tops up by Pix and earns a bonus (e.g. +15%). Loyalty that becomes cash up front — the paid balance never expires and is refundable; the bonus is promotional, with a clear expiry.',
                        pt: 'Seu cliente carrega saldo via Pix e ganha bônus (ex.: +15%). Fidelidade que vira caixa antecipado — o saldo pago não expira e é reembolsável; o bônus é promocional, com validade clara.',
                        es: 'Tu cliente recarga saldo y se lleva un extra (p. ej. +15%). Fidelidad que se convierte en caja por adelantado — el saldo pagado no caduca y es reembolsable; el bono es promocional, con caducidad clara.' },

  // ── carteira, continuação ───────────────────────────────────────────────
  'wallet.statement': { en: 'Statement',                       pt: 'Extrato', es: 'Movimientos' },
  'wallet.topUpEntry':{ en: 'Top-up',                          pt: 'Recarga', es: 'Recarga' },
  'wallet.bonusOf':   { en: 'of bonus',                        pt: 'de bônus', es: 'de bono' },
  'wallet.otherAmt':  { en: 'other amount',                    pt: 'outro valor', es: 'otro importe' },
  'wallet.onlyAt':    { en: 'Valid only at {venue}.',          pt: 'Válido somente no {venue}.', es: 'Válido solo en {venue}.' },
  'wallet.expires':   { en: 'expires on {date}',               pt: 'expira em {date}', es: 'caduca el {date}' },
  'wallet.neverExp':  { en: 'never expires and is refundable', pt: 'não expira e é reembolsável', es: 'no caduca y es reembolsable' },
  'wallet.rules':     { en: 'Paid balance never expires and is refundable. Bonus valid for 90 days after confirmation.',
                        pt: 'Saldo pago não expira e é reembolsável. Bônus válido por 90 dias após a confirmação.',
                        es: 'El saldo pagado no caduca y es reembolsable. El bono vale 90 días desde la confirmación.' },
  'wallet.doTopUp':   { en: 'Top up {amount}',                 pt: 'Carregar {amount}', es: 'Recargar {amount}' },

  // ── login ───────────────────────────────────────────────────────────────
  'gate.google':      { en: 'Continue with Google',            pt: 'Continuar com Google', es: 'Continuar con Google' },
  'gate.orEmail':     { en: 'or with e-mail',                  pt: 'ou com e-mail', es: 'o con correo' },
  'gate.email':       { en: 'e-mail',                          pt: 'e-mail', es: 'correo' },
  'gate.password':    { en: 'password',                        pt: 'senha', es: 'contraseña' },
  'gate.signIn':      { en: 'Sign in',                         pt: 'Entrar', es: 'Entrar' },
  'gate.ownerPanel':  { en: 'owner panel',                     pt: 'painel do dono', es: 'panel del dueño' },

  // ── admin ───────────────────────────────────────────────────────────────
  'admin.title':      { en: 'racha · management',              pt: 'racha · gestão', es: 'racha · gestión' },
  'admin.suggested':  { en: 'Suggested service',               pt: 'Serviço sugerido', es: 'Servicio sugerido' },
  'admin.saved':      { en: 'saved ✓',                         pt: 'salvo ✓', es: 'guardado ✓' },
  'admin.houseOn':    { en: 'Guests can top up prepaid balance with a bonus',
                        pt: 'Clientes podem carregar saldo pré-pago com bônus',
                        es: 'Los clientes pueden recargar saldo prepago con bono' },
  // ── admin: cadastro e gestão de mesas ──────────────────────────────────
  'admin.yourVenues': { en: 'Your restaurants',                pt: 'Seus restaurantes', es: 'Tus restaurantes' },
  'admin.manageTables': { en: 'manage tables →',               pt: 'gerenciar mesas →', es: 'gestionar mesas →' },
  'admin.registerFirst': { en: 'Register your restaurant',     pt: 'Cadastre seu restaurante', es: 'Registra tu restaurante' },
  'admin.registerAnother': { en: 'Register another restaurant', pt: 'Cadastrar outro restaurante', es: 'Registrar otro restaurante' },
  'admin.venueName':  { en: 'Restaurant name',                 pt: 'Nome do restaurante', es: 'Nombre del restaurante' },
  'admin.city':       { en: 'City (optional)',                 pt: 'Cidade (opcional)', es: 'Ciudad (opcional)' },
  'admin.cnpjField':  { en: 'CNPJ (optional)',                 pt: 'CNPJ (opcional)', es: 'CIF/NIF (opcional)' },
  'admin.cnpjOk':     { en: 'CNPJ valid ✓',                    pt: 'CNPJ válido ✓', es: 'CIF/NIF válido ✓' },
  'admin.cnpjBad':    { en: 'CNPJ incomplete or invalid — check all 14 digits.',
                        pt: 'CNPJ incompleto ou inválido — confira os 14 dígitos.',
                        es: 'Documento incompleto o no válido — revisa los dígitos.' },
  'admin.less':       { en: 'less',                            pt: 'menos', es: 'menos' },
  'admin.more':       { en: 'more',                            pt: 'mais', es: 'más' },
  'admin.psplater':   { en: 'The payment rail (Pix/split) is connected later — without it the restaurant exists but does not receive yet. That is what keeps Racha out of holding funds.',
                        pt: 'O meio de pagamento (Pix/split) é conectado depois — sem ele, o restaurante existe mas ainda não recebe. Isso mantém a Racha fora da custódia de recursos.',
                        es: 'El medio de pago se conecta después — sin él, el restaurante existe pero todavía no cobra. Es lo que mantiene a Racha fuera de la custodia de fondos.' },
  'admin.creating':   { en: 'creating…',                       pt: 'criando…', es: 'creando…' },
  'admin.createVenue': { en: 'Create restaurant',              pt: 'Criar restaurante', es: 'Crear restaurante' },
  'admin.footQr':     { en: 'racha · each table’s QR opens the guest’s bill',
                        pt: 'racha · o QR de cada mesa abre a conta do cliente',
                        es: 'racha · el QR de cada mesa abre la cuenta del cliente' },
  // Os dois diálogos do modo manual (`prompt`/`confirm`). O símbolo da moeda é
  // parâmetro: estava `R$` escrito na linha, numa tela que uma casa espanhola
  // também abre.
  // Os três diálogos IRREVERSÍVEIS do dono. Ficaram em português cru até
  // 2026-09-10 porque a detecção do censo é uma lista de palavras escrita à
  // mão, e nem "girar", nem "desativar", nem "reembolsar" estavam nela.
  'admin.rotateAsk':  { en: 'Rotate the QR for {table}? The code printed today stops working immediately.',
                        pt: 'Girar o QR da {table}? O código impresso atual para de funcionar na hora.',
                        es: '¿Rotar el QR de {table}? El código impreso actual deja de funcionar al instante.' },
  'admin.deactivateAsk': { en: 'Deactivate {table}? Its QR stops working.',
                        pt: 'Desativar a {table}? O QR dela para de funcionar.',
                        es: '¿Desactivar {table}? Su QR deja de funcionar.' },
  'house.refundAsk':  { en: 'Refund {name}\n{label}: {balance}\n\nRefund amount ({symbol}):',
                        pt: 'Reembolsar {name}\n{label}: {balance}\n\nValor do reembolso ({symbol}):',
                        es: 'Reembolsar a {name}\n{label}: {balance}\n\nImporte del reembolso ({symbol}):' },
  'admin.openCheckPrompt': { en: 'Open a check on {table}\n\nCheck total ({symbol}):',
                        pt: 'Abrir conta na {table}\n\nTotal da conta ({symbol}):',
                        es: 'Abrir cuenta en {table}\n\nTotal de la cuenta ({symbol}):' },
  'admin.closeCheckConfirm': { en: 'Close the check for {table}?',
                        pt: 'Fechar a conta da {table}?', es: '¿Cerrar la cuenta de {table}?' },
  'admin.totalInvalid': { en: 'Enter a valid total.',           pt: 'Informe um total válido.', es: 'Introduce un total válido.' },
  'admin.loading':    { en: 'loading…',                        pt: 'carregando…', es: 'cargando…' },
  'wallet.loading':   { en: 'loading your wallet…',           pt: 'carregando sua carteira…', es: 'cargando tu cartera…' },
  // Só aparece quando o ambiente está mal configurado, e por isso ficou em
  // português: era a última tela do produto que não obedecia ao seletor. Quem
  // instala a Racha numa casa espanhola lê o erro dela em espanhol.
  'gate.notConfigured': { en: 'Sign-in is not configured (set VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).',
                        pt: 'Login não configurado (defina VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).',
                        es: 'El acceso no está configurado (define VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).' },
  'admin.tablesN':    { en: 'Tables ({n})',                    pt: 'Mesas ({n})', es: 'Mesas ({n})' },
  'admin.printQrs':   { en: '🖨 Print QRs',                    pt: '🖨 Imprimir QRs', es: '🖨 Imprimir QR' },
  'admin.tablesHelp': { en: 'Register each table under the name it has on the floor (“Table 12”, “Bar 3”). Then mark one as {training} so the staff can practise without dirtying the numbers.',
                        pt: 'Cadastre cada mesa com o nome que ela tem no salão (“Mesa 12”, “Balcão 3”). Depois marque uma como {training} pra equipe praticar sem sujar os números.',
                        es: 'Registra cada mesa con el nombre que tiene en la sala (“Mesa 12”, “Barra 3”). Luego marca una como {training} para que el equipo practique sin ensuciar los números.' },
  'admin.tableEg':    { en: 'e.g. Table 12',                   pt: 'Ex.: Mesa 12', es: 'Ej.: Mesa 12' },
  'admin.add':        { en: 'Add',                             pt: 'Adicionar', es: 'Añadir' },
  'admin.noTables':   { en: 'no tables yet — add the first one above.',
                        pt: 'nenhuma mesa ainda — adicione a primeira acima.',
                        es: 'todavía no hay mesas — añade la primera arriba.' },
  'admin.openBill':   { en: 'bill open',                       pt: 'conta aberta', es: 'cuenta abierta' },
  'admin.disabled':   { en: 'disabled',                        pt: 'desativada', es: 'desactivada' },
  'admin.trainingTable': { en: '· training table',             pt: '· mesa de treino', es: '· mesa de prácticas' },
  'admin.qrRotated':  { en: 'QR rotated',                      pt: 'QR girado', es: 'QR rotado' },
  'admin.closeBill':  { en: 'close bill',                      pt: 'fechar conta', es: 'cerrar cuenta' },
  'admin.openBillCta':{ en: 'open bill',                       pt: 'abrir conta', es: 'abrir cuenta' },
  'admin.rotate':     { en: 'rotate',                          pt: 'girar', es: 'rotar' },
  'admin.training':   { en: 'training',                        pt: 'treino', es: 'prácticas' },
  'admin.untrain':    { en: 'stop training',                   pt: 'tirar do treino', es: 'quitar de prácticas' },
  'admin.deactivate': { en: 'deactivate',                      pt: 'desativar', es: 'desactivar' },
  'admin.activate':   { en: 'activate',                        pt: 'ativar', es: 'activar' },
  'admin.houseAdvanced': { en: 'House credit (advanced) — the guest’s prepaid wallet',
                        pt: 'Créditos da casa (avançado) — carteira pré-paga do cliente',
                        es: 'Saldo de la casa (avanzado) — monedero prepago del cliente' },
  'admin.openWizard': { en: 'open the setup assistant',        pt: 'abrir assistente de configuração', es: 'abrir asistente de configuración' },

  // ── implantação (AdminSetup) ───────────────────────────────────────────
  'setup.rollout':    { en: 'Rollout',                         pt: 'Implantação', es: 'Implantación' },
  'setup.inOrder':    { en: 'Follow the steps in order — each one unlocks the next.',
                        pt: 'Siga os passos na ordem — cada um destrava o próximo.',
                        es: 'Sigue los pasos en orden — cada uno desbloquea el siguiente.' },
  'setup.s1':         { en: 'Venue created',                   pt: 'Casa criada', es: 'Casa creada' },
  'setup.s1sub':      { en: '{venue} · suggested service {pct}%',
                        pt: '{venue} · serviço sugerido {pct}%',
                        es: '{venue} · servicio sugerido {pct}%' },
  'setup.s2':         { en: 'Tables under their real names',   pt: 'Mesas com os rótulos reais', es: 'Mesas con sus nombres reales' },
  'setup.s2one':      { en: '1 active table — then print the QRs',
                        pt: '1 mesa ativa — depois imprima os QRs',
                        es: '1 mesa activa — luego imprime los QR' },
  'setup.s2many':     { en: '{n} active tables — then print the QRs',
                        pt: '{n} mesas ativas — depois imprima os QRs',
                        es: '{n} mesas activas — luego imprime los QR' },
  'setup.s2none':     { en: 'register the tables the way they are called on the floor',
                        pt: 'cadastre as mesas como elas se chamam no salão',
                        es: 'registra las mesas como se llaman en la sala' },
  'setup.s3':         { en: 'Payouts connected',               pt: 'Recebimento conectado', es: 'Cobros conectados' },
  'setup.s3ok':       { en: 'recipient created — automatic daily payout',
                        pt: 'recebedor criado — repasse automático diário',
                        es: 'cuenta de cobro creada — abono automático diario' },
  'setup.s3none':     { en: 'without a recipient the tables only work in test: a real charge has nowhere to settle',
                        pt: 'sem recebedor, as mesas só funcionam em teste: cobrança real não tem para onde liquidar',
                        es: 'sin cuenta de cobro las mesas solo funcionan en pruebas: un cobro real no tiene dónde liquidar' },
  'setup.s4':         { en: 'Staff: a training table',         pt: 'Equipe: mesa de treino', es: 'Equipo: mesa de prácticas' },
  'setup.s4ok':       { en: 'training table marked — its payments stay out of the numbers',
                        pt: 'mesa de treino marcada — pagamentos dela ficam fora dos números',
                        es: 'mesa de prácticas marcada — sus pagos quedan fuera de los números' },
  'setup.s4none':     { en: 'mark one table as “training” for the staff’s pre-shift workshop',
                        pt: 'marque uma mesa como “treino” pro workshop pré-turno da equipe',
                        es: 'marca una mesa como “prácticas” para el taller previo al turno' },
  'setup.script':     { en: 'Staff script (15-min workshop + the waiter’s line)',
                        pt: 'Roteiro da equipe (workshop de 15 min + a frase do garçom)',
                        es: 'Guion del equipo (taller de 15 min + la frase del camarero)' },
  'setup.script1':    { en: '1 · 15-minute pre-shift workshop: each waiter scans and pays a pretend bill on their OWN phone, at the training table — doing it dissolves the fear, and the training table stays out of the numbers.',
                        pt: '1 · Workshop pré-turno de 15 min: cada garçom escaneia e paga uma conta de mentira NO PRÓPRIO CELULAR, na mesa de treino — a experiência dissolve o medo, e a mesa de treino fica fora dos números.',
                        es: '1 · Taller de 15 minutos antes del turno: cada camarero escanea y paga una cuenta de mentira EN SU PROPIO MÓVIL, en la mesa de prácticas — hacerlo disuelve el miedo, y la mesa de prácticas queda fuera de los números.' },
  'setup.script2':    { en: '2 · The one line that introduces the QR: {line}',
                        pt: '2 · A frase que apresenta o QR, uma só: {line}',
                        es: '2 · La frase que presenta el QR, una sola: {line}' },
  'setup.script3':    { en: '3 · First real table paid with us there. Week-1 target: ≥25% of bills through the QR — follow it in the Activation section of the venue panel.',
                        pt: '3 · Primeira mesa real paga com a gente presente. Meta da semana 1: ≥25% das contas pelo QR — acompanhe na seção Ativação do painel da casa.',
                        es: '3 · Primera mesa real pagada con nosotros delante. Objetivo de la semana 1: ≥25% de las cuentas por el QR — sígelo en la sección Activación del panel.' },
  'setup.printLink':  { en: 'Print the table QRs',             pt: 'Imprimir os QRs das mesas', es: 'Imprimir los QR de las mesas' },
  // O roteiro que a equipe fala na mesa. Vive no dicionário e não em dois
  // `const` iguais em dois arquivos: era português cru nos dois, e o assistente
  // de implantação é a primeira tela que um dono novo abre.
  //
  // A versão anterior terminava em "a gorjeta vai direto pra gente" — e esta é
  // a única frase do produto que um GARÇOM diz, em voz alta, na mesa. Na boca
  // dele "pra gente" é acerto direto com a equipe: exatamente o arranjo que a
  // Lei 13.419/2017 e o STJ Tema 1102 põem fora da lei, porque o serviço é
  // remuneração e passa pela folha. Escrita como roteiro, ela instruía o cliente
  // a fazer a afirmação errada. O destino sai da frase; o que fica é o que o
  // CDC exige que ele diga — que dá pra tirar.
  'wiz.staffLine':    { en: '“Scan the QR on the table to see the bill and pay whenever you like — the service charge is on it, and it is optional.”',
                        pt: '“Pode escanear o QR da mesa pra ver a conta e pagar quando quiser — o serviço vem junto e é opcional.”',
                        es: '“Puedes escanear el QR de la mesa para ver la cuenta y pagar cuando quieras — el servicio va incluido y es opcional.”' },
  'wiz.stepTables':   { en: 'Tables',                          pt: 'Mesas', es: 'Mesas' },
  'wiz.stepPayout':   { en: 'Payouts',                         pt: 'Recebimento', es: 'Cobros' },
  'wiz.stepStaff':    { en: 'Staff',                           pt: 'Equipe', es: 'Equipo' },
  'wiz.stepDone':     { en: 'Done',                            pt: 'Pronto', es: 'Listo' },
  'wiz.t1':           { en: 'Step 1 · Tables',                 pt: 'Passo 1 · Mesas', es: 'Paso 1 · Mesas' },
  'wiz.t1sub':        { en: 'Register each table under the name it has on the floor (“Table 12”, “Bar 3”). It is what the guest sees when they scan the QR.',
                        pt: 'Cadastre cada mesa com o nome que ela tem no salão (“Mesa 12”, “Balcão 3”). É o que o cliente vê ao escanear o QR.',
                        es: 'Registra cada mesa con el nombre que tiene en la sala (“Mesa 12”, “Barra 3”). Es lo que ve el cliente al escanear el QR.' },
  'wiz.t2':           { en: 'Step 2 · Payouts',                pt: 'Passo 2 · Recebimento', es: 'Paso 2 · Cobros' },
  'wiz.t2sub':        { en: 'Where the money from the bills lands. We validate CPF/CNPJ, bank and account here on the spot; Pagar.me confirms the account (KYC review, about 3 business days).',
                        pt: 'Onde o dinheiro das comandas cai. Validamos CPF/CNPJ, banco e conta aqui na hora; o Pagar.me confirma a conta (análise KYC, ~3 dias úteis).',
                        es: 'Donde cae el dinero de las cuentas. Validamos el documento, el banco y la cuenta aquí mismo; el proveedor confirma la cuenta (revisión KYC, unos 3 días laborables).' },
  'wiz.t3':           { en: 'Step 3 · Staff',                  pt: 'Passo 3 · Equipe', es: 'Paso 3 · Equipo' },
  'wiz.t3sub':        { en: 'Mark one table as training: the staff practise the flow on it without dirtying the venue’s numbers.',
                        pt: 'Marque uma mesa como treino: a equipe pratica o fluxo nela sem sujar os números da casa.',
                        es: 'Marca una mesa como prácticas: el equipo ensaya el flujo en ella sin ensuciar los números de la casa.' },
  'wiz.t4':           { en: 'All set',                         pt: 'Tudo pronto', es: 'Todo listo' },
  'wiz.t4sub':        { en: 'Review and print the QRs. You can come back and change any step later.',
                        pt: 'Revise e imprima os QRs. Você pode voltar e ajustar qualquer passo depois.',
                        es: 'Revisa e imprime los QR. Puedes volver y cambiar cualquier paso más tarde.' },
  'wiz.script1':      { en: '1 · 15-minute pre-shift workshop: each waiter scans and pays a pretend bill on their OWN phone, at the training table — doing it dissolves the fear.',
                        pt: '1 · Workshop pré-turno de 15 min: cada garçom escaneia e paga uma conta de mentira NO PRÓPRIO CELULAR, na mesa de treino — a experiência dissolve o medo.',
                        es: '1 · Taller de 15 minutos antes del turno: cada camarero escanea y paga una cuenta de mentira EN SU PROPIO MÓVIL, en la mesa de prácticas — hacerlo disuelve el miedo.' },
  'wiz.script3':      { en: '3 · First real table paid with us there. Week-1 target: ≥25% of bills through the QR.',
                        pt: '3 · Primeira mesa real paga com a gente presente. Meta da semana 1: ≥25% das contas pelo QR.',
                        es: '3 · Primera mesa real pagada con nosotros delante. Objetivo de la semana 1: ≥25% de las cuentas por el QR.' },
  'wiz.doneTables':   { en: 'Tables registered',               pt: 'Mesas cadastradas', es: 'Mesas registradas' },
  'wiz.doneActive':   { en: '{n} active',                      pt: '{n} ativa(s)', es: '{n} activa(s)' },
  'wiz.donePayout':   { en: 'Payouts',                         pt: 'Recebimento', es: 'Cobros' },
  'wiz.connected':    { en: 'connected',                       pt: 'conectado', es: 'conectado' },
  'wiz.pending':      { en: 'pending',                         pt: 'pendente', es: 'pendiente' },
  'wiz.doneTraining': { en: 'Training table',                  pt: 'Mesa de treino', es: 'Mesa de prácticas' },
  'wiz.marked':       { en: 'marked',                          pt: 'marcada', es: 'marcada' },
  'wiz.none':         { en: 'none',                            pt: 'nenhuma', es: 'ninguna' },
  'wiz.seeQr':        { en: 'see the QR for {table}',          pt: 'ver o QR da {table}', es: 'ver el QR de {table}' },
  'wiz.canFinish':    { en: 'You can finish now and connect payouts later — but without it real charges do not settle.',
                        pt: 'Dá pra concluir agora e conectar o recebimento depois — mas sem ele as cobranças reais não liquidam.',
                        es: 'Puedes terminar ahora y conectar los cobros después — pero sin ellos los cobros reales no liquidan.' },
  'wiz.back':         { en: '← Back',                          pt: '← Voltar', es: '← Atrás' },
  'wiz.next':         { en: 'Next →',                          pt: 'Próximo →', es: 'Siguiente →' },
  'wiz.finish':       { en: 'Finish ✓',                        pt: 'Concluir ✓', es: 'Finalizar ✓' },
  'wiz.needRecipient':{ en: 'Create the recipient above to move on — or go to the panel and connect it later.',
                        pt: 'Crie o recebedor acima pra avançar — ou vá pro painel e conecte depois.',
                        es: 'Crea la cuenta de cobro de arriba para seguir — o ve al panel y conéctala después.' },
  'wiz.straightToPanel': { en: 'go straight to the panel',     pt: 'ir direto pro painel', es: 'ir directo al panel' },
  'setup.tablesFirst': { en: 'register the tables in step 1 first.',
                        pt: 'cadastre mesas no passo 1 primeiro.',
                        es: 'registra mesas en el paso 1 primero.' },
  'setup.printNote':  { en: '— one display per table, never a loose A4.',
                        pt: '— display por mesa, nunca A4 solto.',
                        es: '— un soporte por mesa, nunca un A4 suelto.' },

  // ── folha de QRs ───────────────────────────────────────────────────────
  'qrs.title':        { en: 'Table QRs ({n})',                 pt: 'QRs das mesas ({n})', es: 'QR de las mesas ({n})' },
  'qrs.help':         { en: 'One card per active table — disabled and training tables are left out. Tip: save as PDF from the print dialog to send to a print shop.',
                        pt: 'Um cartão por mesa ativa — mesas desativadas e de treino ficam de fora. Dica: salve como PDF na caixa de impressão para mandar à gráfica.',
                        es: 'Una tarjeta por mesa activa — las desactivadas y las de prácticas quedan fuera. Consejo: guarda como PDF desde el diálogo de impresión para enviarlo a la imprenta.' },
  // O cartão sai da IMPRESSORA DO DONO, no idioma em que ele está lendo a
  // tela. O rótulo da mesa continua sendo palavra da casa: o prefixo só entra
  // quando a casa não escreveu um.
  'qrs.tableTitle':   { en: 'Table {label}',                    pt: 'Mesa {label}', es: 'Mesa {label}' },
  'qrs.print':        { en: 'Print',                           pt: 'Imprimir', es: 'Imprimir' },
  'qrs.preparing':    { en: 'preparing the QRs…',              pt: 'preparando os QRs…', es: 'preparando los QR…' },
  'qrs.backTables':   { en: '← tables',                        pt: '← mesas', es: '← mesas' },
  'qrs.noneActive':   { en: 'no active table to print.',       pt: 'nenhuma mesa ativa para imprimir.', es: 'no hay mesas activas para imprimir.' },

  // ── Stripe ─────────────────────────────────────────────────────────────
  'stripe.title':     { en: 'Card / Apple Pay (Stripe)',       pt: 'Cartão / Apple Pay (Stripe)', es: 'Tarjeta / Apple Pay (Stripe)' },
  // Sem nomear o trilho local: "além do Pix" numa tela espanhola é errado, e o
  // que importa nesta frase é o mesmo nos dois mercados — cartão e carteiras,
  // dinheiro direto na conta da casa, dados bancários na página da Stripe.
  'stripe.blurb':     { en: 'Accept card, Apple Pay and Google Pay as well. The money lands straight in the restaurant’s account, with no custody by us. You connect a Stripe account and fill in the details on Stripe’s own secure page — the bank details never pass through Racha.',
                        pt: 'Aceitar cartão, Apple Pay e Google Pay também. O dinheiro cai direto na conta do restaurante, sem custódia nossa. Você conecta uma conta Stripe e faz o cadastro na página segura da Stripe — os dados bancários não passam pela Racha.',
                        es: 'Acepta tarjeta, Apple Pay y Google Pay también. El dinero cae directo en la cuenta del restaurante, sin custodia por nuestra parte. Conectas una cuenta de Stripe y rellenas los datos en su propia página segura — los datos bancarios nunca pasan por Racha.' },
  'wiz.t2subEs':      { en: 'Where the money from the bills lands. You connect a Stripe account and enter the IBAN and KYC details on Stripe’s page; the bank details never pass through Racha.',
                        pt: 'Onde o dinheiro das comandas cai. Você conecta uma conta Stripe e preenche IBAN e KYC na página deles; os dados bancários não passam pela Racha.',
                        es: 'Donde cae el dinero de las cuentas. Conectas una cuenta de Stripe e introduces el IBAN y los datos de KYC en su página; los datos bancarios nunca pasan por Racha.' },
  'stripe.active':    { en: 'Active · takes card/Apple Pay',   pt: 'Ativo · aceita cartão/Apple Pay', es: 'Activo · acepta tarjeta/Apple Pay' },
  'stripe.pending':   { en: 'Under review — finish the sign-up at Stripe',
                        pt: 'Em análise — termine o cadastro na Stripe',
                        es: 'En revisión — termina el registro en Stripe' },
  'stripe.opening':   { en: 'opening Stripe…',                 pt: 'abrindo Stripe…', es: 'abriendo Stripe…' },
  'stripe.continue':  { en: 'Continue sign-up at Stripe',      pt: 'Continuar cadastro na Stripe', es: 'Continuar el registro en Stripe' },
  'stripe.connect':   { en: 'Connect Stripe',                  pt: 'Conectar Stripe', es: 'Conectar Stripe' },

  // ── créditos da casa (admin) ───────────────────────────────────────────
  // Os quatro rótulos do formulário de configuração do saldo. Ficaram em
  // português cru até 2026-09-10 porque *validade*, *bônus*, *recarga*,
  // *mínima* e *máxima* não estavam na lista de palavras do censo — a lista é o
  // teto do método, não a âncora. Achado da revisão de compliance.
  'house.cfgBonus':   { en: 'Bonus per top-up (%)',            pt: 'Bônus por recarga (%)', es: 'Bono por recarga (%)' },
  'house.cfgValidity': { en: 'Bonus validity (days) — the legal floor is 30',
                        pt: 'Validade do bônus (dias) — mínimo legal 30 dias',
                        es: 'Validez del bono (días) — el mínimo legal es 30' },
  'house.cfgMinLoad': { en: 'Minimum top-up ({symbol})',       pt: 'Recarga mínima ({symbol})', es: 'Recarga mínima ({symbol})' },
  'house.cfgMaxLoad': { en: 'Maximum top-up ({symbol})',       pt: 'Recarga máxima ({symbol})', es: 'Recarga máxima ({symbol})' },
  'house.badValues':  { en: 'Check the amounts — use a comma for the cents (e.g. 1000,00).',
                        pt: 'Confira os valores — use vírgula para os centavos (ex.: 1000,00).',
                        es: 'Revisa los importes — usa coma para los céntimos (p. ej. 1000,00).' },
  'house.badAmount':  { en: 'Enter a valid amount.',           pt: 'Informe um valor válido.', es: 'Introduce un importe válido.' },
  'house.saving':     { en: 'saving…',                         pt: 'salvando…', es: 'guardando…' },
  'house.saveConfig': { en: 'Save settings',                   pt: 'Salvar configuração', es: 'Guardar configuración' },
  'house.accountsCount': { en: 'Accounts ({n})',                pt: 'Contas ({n})', es: 'Cuentas ({n})' },
  'house.noAccounts': { en: 'no accounts yet.',                pt: 'nenhuma conta ainda.', es: 'todavía no hay cuentas.' },
  'house.paidTag':    { en: '{amount} paid',                    pt: '{amount} pago', es: '{amount} pagado' },
  'house.bonusTag':   { en: '{amount} bonus',                   pt: '{amount} bônus', es: '{amount} de bono' },
  'house.linkCopied': { en: 'link copied ✓',                    pt: 'link copiado ✓', es: 'enlace copiado ✓' },
  'house.copyLink':   { en: 'copy the wallet link',             pt: 'copiar link da carteira', es: 'copiar el enlace de la cartera' },
  'house.newLink':    { en: 'new link',                        pt: 'novo link', es: 'nuevo enlace' },
  'house.newLinkAsk': { en: 'Generate a new wallet link for {name}? The old link stops working immediately.',
                        pt: 'Gerar novo link de carteira para {name}? O link antigo para de funcionar na hora.',
                        es: '¿Generar un nuevo enlace de monedero para {name}? El anterior deja de funcionar al instante.' },
  'admin.cpfOk':      { en: 'CPF valid ✓',                     pt: 'CPF válido ✓', es: 'CPF válido ✓' },
  'admin.hasOpenBill':{ en: '{table} has an open bill — close it before deactivating.',
                        pt: '{table} tem conta aberta — feche antes de desativar.',
                        es: '{table} tiene una cuenta abierta — ciérrala antes de desactivar.' },
  'admin.useInTraining': { en: 'use for training',             pt: 'usar no treino', es: 'usar en prácticas' },
  'house.refund':     { en: 'refund',                          pt: 'reembolsar', es: 'reembolsar' },

  // ── recebedor (payouts) ────────────────────────────────────────────────
  'rcpt.notFound':    { en: '⚠ The registered recipient was not found in this Pagar.me environment — it was probably created in test while the app is already live. Create a new one below; it replaces the old one.',
                        pt: '⚠ O recebedor cadastrado não foi encontrado no Pagar.me deste ambiente — provavelmente foi criado em teste e o app já está em live. Crie um novo abaixo; ele substitui o antigo.',
                        es: '⚠ La cuenta de cobro registrada no aparece en este entorno del proveedor — probablemente se creó en pruebas y la app ya está en producción. Crea una nueva abajo; sustituye a la anterior.' },
  'rcpt.none':        { en: '⚠ No recipient configured — real charges do not settle until you create one.',
                        pt: '⚠ Sem recebedor configurado — cobranças reais não liquidam até criar.',
                        es: '⚠ Sin cuenta de cobro configurada — los cobros reales no liquidan hasta crearla.' },
  'rcpt.holderPh':    { en: 'As it appears on the bank record',
                        pt: 'Como está no cadastro do banco',
                        es: 'Tal como figura en el banco' },
  'rcpt.pickBank':    { en: 'Select the bank…',                pt: 'Selecione o banco…', es: 'Selecciona el banco…' },
  'rcpt.otherBank':   { en: 'Another bank (type the code)…',   pt: 'Outro banco (digitar código)…', es: 'Otro banco (escribir código)…' },
  'rcpt.noBranchDv':  { en: 'Leave it empty if the branch has no check digit.',
                        pt: 'Deixe vazio se a agência não tem dígito.',
                        es: 'Déjalo vacío si la sucursal no tiene dígito de control.' },
  'rcpt.sameDoc':     { en: 'The account must belong to the same CNPJ/CPF as the document — that is Pagar.me’s KYC rule.',
                        pt: 'A conta precisa pertencer ao mesmo CNPJ/CPF do documento — é a regra do KYC do Pagar.me.',
                        es: 'La cuenta debe pertenecer al mismo documento fiscal — es la norma KYC del proveedor.' },
  'rcpt.esVia':       { en: 'Payouts are set up with Stripe: you enter the IBAN and the KYC details on their page, so the bank details never pass through Racha.',
                        pt: 'O recebimento é configurado na Stripe: o IBAN e os dados de KYC você preenche na página deles, então os dados bancários nunca passam pela Racha.',
                        es: 'Los cobros se configuran en Stripe: el IBAN y los datos de KYC los introduces en su página, así que los datos bancarios nunca pasan por Racha.' },
  'rcpt.marketplaceHint': { en: 'The Pagar.me account is not in marketplace mode yet — sales has to enable it (already requested).',
                        pt: 'A conta Pagar.me ainda não está em modo marketplace — o comercial precisa habilitar (pedido já feito).',
                        es: 'La cuenta de Pagar.me todavía no está en modo marketplace — el equipo comercial tiene que habilitarlo (ya solicitado).' },
  'rcpt.docIncomplete': { en: 'A CPF has 11 digits, a CNPJ has 14 — some are still missing.',
                        pt: 'CPF tem 11 dígitos, CNPJ tem 14 — ainda faltam números.',
                        es: 'El CPF tiene 11 dígitos y el CNPJ 14 — todavía faltan números.' },
  'rcpt.docDvBad':    { en: 'The check digits do not match — check the number.',
                        pt: 'Os dígitos verificadores não batem — confira o número.',
                        es: 'Los dígitos de control no coinciden — revisa el número.' },
  'rcpt.fixFields':   { en: 'Check the fields highlighted in red before continuing.',
                        pt: 'Confira os campos destacados em vermelho antes de continuar.',
                        es: 'Revisa los campos marcados en rojo antes de continuar.' },
  'rcpt.section':     { en: 'Payouts',                         pt: 'Recebimento', es: 'Cobros' },
  'rcpt.active':      { en: 'Recipient active · {id}',         pt: 'Recebedor ativo · {id}', es: 'Cuenta de cobro activa · {id}' },
  'rcpt.review':      { en: 'Under review · {id}',             pt: 'Em análise · {id}', es: 'En revisión · {id}' },
  'rcpt.statusOther': { en: '{id} · status: {status}',          pt: '{id} · status: {status}', es: '{id} · estado: {status}' },
  'rcpt.unknown':     { en: 'unknown',                         pt: 'desconhecido', es: 'desconocido' },
  'rcpt.idCopied':    { en: 'id copied ✓',                     pt: 'id copiado ✓', es: 'id copiado ✓' },
  'rcpt.copyId':      { en: 'copy id',                         pt: 'copiar id', es: 'copiar id' },
  'rcpt.kycWait':     { en: 'Under review at Pagar.me (KYC) — about 3 business days is normal.',
                        pt: 'Em análise no Pagar.me (KYC) — normal levar ~3 dias úteis.',
                        es: 'En revisión por el proveedor (KYC) — lo normal son unos 3 días laborables.' },
  'rcpt.holder':      { en: 'Holder: {name}',                  pt: 'Titular: {name}', es: 'Titular: {name}' },
  'rcpt.created':     { en: 'Recipient {id} created ✓ — status: {status}',
                        pt: 'Recebedor {id} criado ✓ — status: {status}',
                        es: 'Cuenta de cobro {id} creada ✓ — estado: {status}' },
  'rcpt.recreate':    { en: 'recreate recipient',              pt: 'recriar recebedor', es: 'volver a crear la cuenta de cobro' },
  'rcpt.intro':       { en: 'These are the restaurant’s bank details — where the money from the bills lands. They must be exactly the account’s details at the bank; Pagar.me checks them against the tax authority and refuses if they do not match.',
                        pt: 'São os dados bancários do restaurante — é pra onde o dinheiro das comandas cai. Precisam ser exatamente os dados da conta no banco; o Pagar.me confere com a Receita e recusa se não bater.',
                        es: 'Son los datos bancarios del restaurante — es donde cae el dinero de las cuentas. Tienen que ser exactamente los datos de la cuenta en el banco; el proveedor los comprueba con la administración y los rechaza si no coinciden.' },
  'rcpt.holderLabel': { en: 'Legal name / account holder',      pt: 'Razão social / nome do titular', es: 'Razón social / nombre del titular' },
  'rcpt.holderNeed':  { en: 'Enter the account holder’s name.', pt: 'Informe o nome do titular da conta.', es: 'Introduce el nombre del titular de la cuenta.' },
  'rcpt.holderHint':  { en: 'Same as the bank and tax records.', pt: 'Igual ao cadastro no banco / na Receita.', es: 'Igual que en el banco y en la administración.' },
  'rcpt.docLabel':    { en: 'Holder’s CNPJ or CPF',            pt: 'CNPJ ou CPF do titular', es: 'Documento fiscal del titular' },
  // O dono digita este documento num passo de KYC — e é ELE que passa a
  // aparecer no comprovante do cliente, porque a casa herda o documento do
  // recebedor quando ainda não tem um (`decidirDocumentoDoRecebedor`). Herança
  // silenciosa num campo que vai pra tela de terceiro é o tipo de coisa que se
  // descobre numa revisão; dizer é barato. Achado pela revisão de compliance
  // de 2026-09-13.
  'rcpt.docOnReceipt': { en: 'This is also the document shown on the diner’s receipt.',
                        pt: 'Este é também o documento que aparece no comprovante do cliente.',
                        es: 'Es también el documento que aparece en el recibo del cliente.' },
  'rcpt.docHint':     { en: 'The restaurant’s CNPJ (14 digits) or your CPF (11 digits).',
                        pt: 'CNPJ do restaurante (14 díg.) ou seu CPF (11 díg.).',
                        es: 'El documento de la empresa o el tuyo como autónomo.' },
  'rcpt.emailLabel':  { en: 'Restaurant e-mail',               pt: 'E-mail do restaurante', es: 'Correo del restaurante' },
  'rcpt.emailBad':    { en: 'Invalid e-mail — check the format.', pt: 'E-mail inválido — confira o formato.', es: 'Correo no válido — revisa el formato.' },
  // Exemplo, e exemplo é tela: um e-mail `.com.br` numa tela espanhola diz
  // pra pessoa que o formulário não é pra ela.
  'rcpt.emailPh':     { en: 'contact@restaurant.com',           pt: 'contato@restaurante.com.br', es: 'contacto@restaurante.es' },
  'rcpt.emailHint':   { en: 'Pagar.me requires it — used to notify you about payouts.',
                        pt: 'O Pagar.me exige — usa pra avisar sobre os repasses.',
                        es: 'El proveedor lo exige — lo usa para avisar de los abonos.' },
  'rcpt.waLabel':     { en: 'Owner’s WhatsApp (alerts)',       pt: 'WhatsApp do dono (avisos)', es: 'WhatsApp del dueño (avisos)' },
  'rcpt.waHint':      { en: 'So we can tell you on WhatsApp when KYC approves (or refuses). Without it, e-mail only.',
                        pt: 'Pra te avisar por WhatsApp quando o KYC aprovar (ou recusar). Sem isso, só por e-mail.',
                        es: 'Para avisarte por WhatsApp cuando el KYC apruebe (o rechace). Sin esto, solo por correo.' },
  'rcpt.bankLabel':   { en: 'Bank',                            pt: 'Banco', es: 'Banco' },
  'rcpt.bankCodePh':  { en: 'Clearing code (3 digits, e.g. 218)', pt: 'Código de compensação (3 dígitos, ex.: 218)', es: 'Código de compensación (3 dígitos, p. ej. 218)' },
  'rcpt.bankCodeBad': { en: 'The clearing code has 3 digits.',  pt: 'O código de compensação tem 3 dígitos.', es: 'El código de compensación tiene 3 dígitos.' },
  'rcpt.bankCodeKnown': { en: 'Code {code} — {bank}.',          pt: 'Código {code} — {bank}.', es: 'Código {code} — {bank}.' },
  'rcpt.bankCodeHint':{ en: 'The bank’s clearing code (3 digits).', pt: 'Código de compensação do banco (3 dígitos).', es: 'Código de compensación del banco (3 dígitos).' },
  'rcpt.bankPickBad': { en: 'Choose the account’s bank.',       pt: 'Escolha o banco da conta.', es: 'Elige el banco de la cuenta.' },
  'rcpt.bankHint':    { en: 'Where the restaurant’s account is.', pt: 'Onde a conta do restaurante está.', es: 'Dónde está la cuenta del restaurante.' },
  'rcpt.typeLabel':   { en: 'Account type',                     pt: 'Tipo de conta', es: 'Tipo de cuenta' },
  'rcpt.checking':    { en: 'Checking',                         pt: 'Corrente', es: 'Corriente' },
  'rcpt.savings':     { en: 'Savings',                          pt: 'Poupança', es: 'Ahorro' },
  'rcpt.branch':      { en: 'Branch',                           pt: 'Agência', es: 'Sucursal' },
  'rcpt.branchNeed':  { en: 'Enter the branch.',                pt: 'Informe a agência.', es: 'Introduce la sucursal.' },
  'rcpt.branchHint':  { en: 'Without the check digit — that goes in the field beside it.',
                        pt: 'Sem o dígito — ele vai no campo ao lado.',
                        es: 'Sin el dígito de control — ese va en el campo de al lado.' },
  'rcpt.branchDv':    { en: 'Branch check digit',              pt: 'Dígito da agência', es: 'Dígito de la sucursal' },
  'rcpt.optionalPh':  { en: 'optional',                        pt: 'opcional', es: 'opcional' },
  'rcpt.account':     { en: 'Account',                         pt: 'Conta', es: 'Cuenta' },
  'rcpt.accountNeed': { en: 'Enter the account number.',       pt: 'Informe o número da conta.', es: 'Introduce el número de cuenta.' },
  'rcpt.accountHint': { en: 'The account number, without the check digit.',
                        pt: 'Número da conta, sem o dígito.',
                        es: 'El número de cuenta, sin el dígito de control.' },
  'rcpt.accountDv':   { en: 'Account check digit',             pt: 'Dígito da conta', es: 'Dígito de la cuenta' },
  'rcpt.accountDvNeed': { en: 'Enter the account’s check digit.', pt: 'Informe o dígito da conta.', es: 'Introduce el dígito de control de la cuenta.' },
  'rcpt.accountDvHint': { en: 'Usually 1 character (it can be an X).',
                        pt: 'Geralmente 1 caractere (pode ser X).',
                        es: 'Normalmente 1 carácter (puede ser una X).' },
  'rcpt.sending':     { en: 'sending…',                        pt: 'enviando…', es: 'enviando…' },
  'rcpt.create':      { en: 'Create recipient',                pt: 'Criar recebedor', es: 'Crear cuenta de cobro' },
  'rcpt.cancel':      { en: 'cancel',                          pt: 'cancelar', es: 'cancelar' },

  'admin.point':      { en: 'Point the camera · pay your share with Pix',
                        pt: 'Aponte a câmera · pague sua parte por Pix',
                        es: 'Apunta la cámara · paga tu parte' },
  'qr.perks':         { en: '💳 Google Pay · 💰 House balance with bonus',
                        pt: '💳 Google Pay · 💰 Saldo da casa com bônus',
                        es: '💳 Google Pay · 💰 Saldo de la casa con bono' },

  // ── cartão (demo) ───────────────────────────────────────────────────────
  'card.demoCard':    { en: '•••• 4242 (demo)',                pt: '•••• 4242 (demo)', es: '•••• 4242 (demo)' },

  'gate.newPassword': { en: 'create a password',              pt: 'crie uma senha', es: 'crea una contraseña' },
  'wallet.bonusOnConfirm': { en: '+{amount} bonus when the payment confirms',
                             pt: '+{amount} de bônus quando o pagamento confirmar',
                        es: '+{amount} de bono cuando se confirme el pago' },
  'wallet.bonusLine': { en: ' · +{amount} bonus',             pt: ' · +{amount} de bônus', es: ' · +{amount} de bono' },
  'wallet.pitchBonus': { en: 'Top up by Pix and get {pct}% bonus on every top-up.',
                         pt: 'Carregue saldo por Pix e ganhe {pct}% de bônus em cada recarga.',
                        es: 'Recarga saldo y llévate un {pct}% extra en cada recarga.' },
  'wallet.rulesFull':  { en: 'Paid balance never expires and is refundable. The promotional bonus is valid for {days} days. Valid only at {venue}.',
                         pt: 'Saldo pago não expira e é reembolsável. O bônus promocional vale por {days} dias. Válido somente no {venue}.',
                        es: 'El saldo pagado no caduca y es reembolsable. El bono promocional vale {days} días. Válido solo en {venue}.' },

  'ledger.load':   { en: 'Top-up',        pt: 'Recarga', es: 'Recarga' },
  'ledger.redeem': { en: 'Paid at table', pt: 'Pagamento na mesa', es: 'Pago en la mesa' },
  'ledger.refund': { en: 'Refund',        pt: 'Reembolso', es: 'Reembolso' },

  'wallet.bonusDays': { en: 'Bonus valid for {days} days after confirmation.',
                        pt: 'Bônus válido por {days} dias após a confirmação.',
                        es: 'El bono vale {days} días desde la confirmación.' },
  'wallet.brand':     { en: 'racha · house balance',    pt: 'racha · saldo da casa', es: 'racha · saldo de la casa' },
  'wallet.noHouse':   { en: '{venue} does not offer a house balance yet.',
                        pt: 'O {venue} ainda não oferece saldo da casa.',
                        es: '{venue} todavía no ofrece saldo de la casa.' },

  // ── landing: o herói (a noite do bar) ───────────────────────────────────
  'land.eyebrow':   { en: 'Pay at the table · Brazil',        pt: 'Pagamento na mesa · Brasil', es: 'Pago en la mesa · España' },
  'land.h1a':       { en: 'Say who had what.',                pt: 'Fala o que foi de quem.', es: 'Di quién tomó qué.' },
  'land.h1b':       { en: 'I’ll do the bill.',                pt: 'Eu faço a conta.', es: 'Yo hago la cuenta.' },
  'land.sub':       { en: 'Scan the table QR, say who had what, and everyone pays the house straight over Pix. No app, no sign-up, no card machine passed around the table.',
                      pt: 'Escaneia o QR da mesa, fala o que foi de quem, e cada um paga a casa direto no Pix. Sem app, sem cadastro, sem maquininha passando de mão em mão.',
                        es: 'Escanea el QR de la mesa, di quién tomó qué, y cada uno paga a la casa con Bizum. Sin app, sin registro, sin datáfono pasando de mano en mano.' },
  'land.try':       { en: 'Try the live demo',                pt: 'Experimente a demo ao vivo', es: 'Prueba la demo en directo' },
  'land.tryHint':   { en: 'This phone is the real product. Tap it.',
                      pt: 'Este telefone é o produto de verdade. Toque nele.',
                        es: 'Este móvil es el producto de verdad. Tócalo.' },
  'land.demoFrame':   { en: 'Racha — live demo',                pt: 'Racha — demo ao vivo', es: 'Racha — demo en directo' },
  'land.forVenues': { en: 'I run a restaurant',               pt: 'Tenho um restaurante', es: 'Tengo un restaurante' },
  'land.proof1':    { en: 'Pix settles to the restaurant’s own account', pt: 'O Pix cai na conta do próprio restaurante', es: 'El pago cae en la cuenta del propio restaurante' },
  'land.proof2':    { en: 'Service charge optional, tracked for payroll', pt: 'Serviço opcional, rastreado pra folha', es: 'Servicio opcional, registrado para la nómina' },
  'land.proof3':    { en: 'We never hold your money',           pt: 'A gente nunca segura o seu dinheiro', es: 'Nunca retenemos tu dinero' },
  'land.menuLabel': { en: 'Every line gets its block',          pt: 'Cada linha tem seu bloco', es: 'Cada línea tiene su grabado' },
  'land.menuSub':   { en: 'Fourteen woodcuts, carved in one pass, one for each thing a bar bill prints.',
                      pt: 'Catorze xilogravuras, entalhadas de uma vez, uma pra cada coisa que uma conta de bar imprime.',
                        es: 'Catorce xilografías, talladas de una vez, una para cada cosa que imprime la cuenta de un bar.' },
  'land.venueTitle':{ en: 'For the house',                     pt: 'Para a casa', es: 'Para la casa' },
  'land.venueSub':  { en: 'The table turns faster at the rush. Tips go to payroll, the way the law wants. Reconciliation to the cent, every night.',
                      pt: 'A mesa gira mais rápido no rush. Gorjeta vai pra folha, do jeito que a lei pede. Conciliação ao centavo, toda noite.',
                        es: 'La mesa rota más rápido en hora punta. La propina llega a la nómina, como pide la ley. Conciliación al céntimo, cada noche.' },
  'land.openPanel': { en: 'Open the restaurant panel',         pt: 'Abrir o painel do restaurante', es: 'Abrir el panel del restaurante' },

  'cat.carne': { en: 'Meat', pt: 'Carne', es: 'Carne' }, 'cat.peixe': { en: 'Fish', pt: 'Peixe', es: 'Pescado' },
  'cat.massa': { en: 'Pasta', pt: 'Massa', es: 'Pasta' }, 'cat.petisco': { en: 'Bar snacks', pt: 'Petisco', es: 'Tapas' },
  'cat.salada': { en: 'Salad', pt: 'Salada', es: 'Ensalada' }, 'cat.acompanhamento': { en: 'Sides', pt: 'Acompanhamento', es: 'Guarnición' },
  'cat.sobremesa': { en: 'Dessert', pt: 'Sobremesa', es: 'Postre' }, 'cat.cerveja': { en: 'Beer', pt: 'Cerveja', es: 'Cerveza' },
  'cat.drink': { en: 'Cocktail', pt: 'Drink', es: 'Cóctel' }, 'cat.vinho': { en: 'Wine', pt: 'Vinho', es: 'Vino' },
  'cat.refrigerante': { en: 'Soft drink', pt: 'Refrigerante', es: 'Refresco' }, 'cat.cafe': { en: 'Coffee', pt: 'Café', es: 'Café' },
  'cat.suco': { en: 'Juice', pt: 'Suco', es: 'Zumo' }, 'cat.couvert': { en: 'Cover charge', pt: 'Couvert', es: 'Cubierto' },
  'land.proofs':    { en: 'Pix lands in the restaurant’s own account · Service optional, tracked for payroll · We never hold your money',
                      pt: 'O Pix cai na conta do próprio restaurante · Serviço opcional, rastreado pra folha · A gente nunca segura o seu dinheiro',
                        es: 'El pago cae en la cuenta del propio restaurante · Servicio opcional, registrado para la nómina · Nunca retenemos tu dinero' },
  'land.specimen':  { en: 'The bill, illustrated',              pt: 'A conta, ilustrada', es: 'La cuenta, ilustrada' },
  'land.specimenSub':{ en: 'One woodcut for each thing a bar bill prints.',
                       pt: 'Uma xilogravura pra cada coisa que uma conta de bar imprime.',
                        es: 'Una xilografía para cada cosa que imprime la cuenta de un bar.' },
  'land.h2how':     { en: 'Three moves. Under a minute.',        pt: 'Três gestos. Menos de um minuto.', es: 'Tres gestos. Menos de un minuto.' },
  'land.house1':    { en: 'The table turns faster at the rush.', pt: 'A mesa gira mais rápido no rush.', es: 'La mesa rota más rápido en hora punta.' },
  'land.house2':    { en: 'Tips reach payroll, as the law requires.', pt: 'A gorjeta chega na folha, como a lei exige.', es: 'La propina llega a la nómina, como exige la ley.' },
  'land.house3':    { en: 'Reconciled to the cent, every night.', pt: 'Conciliado ao centavo, toda noite.', es: 'Conciliado al céntimo, cada noche.' },
  'land.house4':    { en: 'Prepaid house balance turns loyalty into cash up front.', pt: 'Saldo da casa pré-pago transforma fidelidade em caixa antecipado.', es: 'El saldo prepago de la casa convierte fidelidad en caja por adelantado.' },

  'land.nav':      { en: 'For restaurants',                pt: 'Para restaurantes', es: 'Para restaurantes' },
  'land.house0':   { en: 'Pix lands in the restaurant’s own account. We never hold the money.',
                     pt: 'O Pix cai na conta do próprio restaurante. A gente nunca segura o dinheiro.',
                        es: 'El pago cae en la cuenta del propio restaurante. Nunca retenemos el dinero.' },

  'land.proofTitle': { en: 'To the cent. Always.',            pt: 'Ao centavo. Sempre.', es: 'Al céntimo. Siempre.' },
  'land.proofSub':   { en: 'Every split sums back to the bill exactly. When the cents don’t divide, the remainder goes to one share — never rounded away, never invented.',
                       pt: 'Toda divisão soma de volta à conta, exata. Quando os centavos não dividem, o resto vai pra uma parte — nunca arredondado fora, nunca inventado.',
                        es: 'Cada división suma exactamente la cuenta. Cuando los céntimos no dividen, el resto va a una de las partes — nunca redondeado, nunca inventado.' },
  'land.proofEach':  { en: 'each', pt: 'cada', es: 'cada uno' },
  'land.proofRem':   { en: 'the remaining cent', pt: 'o centavo que sobra', es: 'el céntimo que sobra' },

  'land.proofCap':  { en: 'Three shares. The cent that won’t divide lands on one of them — never rounded away, never invented.',
                      pt: 'Três partes. O centavo que não divide cai numa delas — nunca arredondado fora, nunca inventado.',
                        es: 'Tres partes. El céntimo que no divide cae en una de ellas — nunca redondeado, nunca inventado.' },
} satisfies Record<string, Trio>;

export type Key = keyof typeof DICT;


/**
 * Dinheiro. A MOEDA não muda com o idioma — a conta é em reais nos dois casos,
 * e "R$" continua "R$". O que muda é a separação: um leitor de inglês lê
 * "R$ 1.234,56" como mil e duzentos reais e trinta e quatro centavos errados.
 */
/** O locale de cada idioma. É só a SEPARAÇÃO — a moeda vem da casa. */
export const LOCALE: Record<Lang, string> = { en: 'en-US', pt: 'pt-BR', es: 'es-ES' };

/**
 * O idioma dos elementos da Stripe.
 *
 * NÃO é o `LOCALE` acima: a Stripe tem a lista dela, e `es-ES` não está nela —
 * um código que ela não conhece cai no idioma do navegador em silêncio, que é
 * justamente o bug. Confirmado na tela (2026-09-07): sem este parâmetro, o
 * campo de telefone do Bizum, os nomes dos países e o aviso legal do Open Bank
 * apareciam em INGLÊS numa conta espanhola em espanhol — a única parte da tela
 * de pagar que não obedecia ao seletor, e a parte que pede um dado pessoal.
 */
export const STRIPE_LOCALE: Record<Lang, 'en' | 'pt-BR' | 'es'> = {
  en: 'en', pt: 'pt-BR', es: 'es',
};

/**
 * O mercado da LANDING, por idioma.
 *
 * Numa conta o mercado vem do servidor, junto da mesa. Aqui não existe mesa —
 * é uma página de marketing, e o idioma é o único sinal que existe. Então a
 * escolha é explícita, num lugar, em vez de espalhada em frases.
 *
 * O que isso conserta, visto na tela em 2026-09-07: a landing espanhola dizia
 * "PAGO EN LA MESA · ESPAÑA", prometia Bizum no herói, e depois mostrava "Pix
 * directo a la cuenta del restaurante" e a conta de exemplo em REAIS —
 * "237,10 R$" debaixo de "AL CÉNTIMO. SIEMPRE.". A página se contradizendo
 * três vezes, na parte que é o argumento de venda.
 *
 * O inglês aponta pro Brasil de propósito: é o mercado de hoje, o herói já diz
 * "· Brazil", e uma página que fala dos dois não vende nenhum. Quando a Espanha
 * tiver landing própria, é esta tabela que muda.
 */
export const LANDING_MARKET: Record<Lang, { currency: CurrencyCode; rail: 'pix' | 'bizum' }> = {
  en: { currency: 'BRL', rail: 'pix' },
  pt: { currency: 'BRL', rail: 'pix' },
  es: { currency: 'EUR', rail: 'bizum' },
};

/** As moedas que o produto atende. Ambas de 2 casas — ver api/_lib/markets.js. */
export type CurrencyCode = 'BRL' | 'EUR';

export function money(cents: number, lang: Lang, currency: CurrencyCode = 'BRL'): string {
  return (cents / 100).toLocaleString(LOCALE[lang], {
    style: 'currency', currency,
    // `narrowSymbol` porque o padrão do espanhol para o REAL é o código:
    // `Intl` em `es-ES` devolve "213,10 BRL", e a mesma tela desenha "R$" no
    // rótulo do campo de valor. Duas grafias da mesma moeda lado a lado, numa
    // tela de pagar, fazem a pessoa procurar a diferença entre elas.
    //
    // Visto numa mesa brasileira lida em espanhol (2026-09-07) — o caso do
    // turista, que é justamente pra quem o seletor existe. O símbolo é o que
    // está impresso no menu da casa, e o menu da casa não se traduz
    // (CLAUDE.md). O que segue o leitor é a SEPARAÇÃO e a POSIÇÃO do símbolo,
    // não o símbolo.
    currencyDisplay: 'narrowSymbol',
  });
}

/** Tradução de um erro do servidor pelo CÓDIGO, com o texto dele como reserva. */
export function tError(lang: Lang, code: string | undefined, fallback: string,
                       vars?: Record<string, string | number>): string {
  const key = `err.${code}` as Key;
  if (code && key in DICT) return fill(DICT[key][lang], vars);
  // Código que o dicionário não conhece: a frase GENÉRICA, traduzida.
  //
  // Antes caía no texto cru do servidor, e isso fazia sentido enquanto o
  // servidor mandava uma frase. Ele parou: um 4xx com código não manda mais
  // mensagem, porque a mensagem interna nomeava o adquirente da casa e servia
  // de oráculo de assinatura nos webhooks. Então o "texto cru" hoje seria o
  // `HTTP 400` que o `api.ts` inventa — pior que uma frase honesta em pé.
  //
  // Um código sem tradução não deve existir: há um teste que varre a API e
  // exige `err.<code>` pra cada um. Este ramo é o cinto, não a calça.
  if (code) return fill(DICT['err.generic'][lang]);
  return fallback;   // servidor antigo, sem código: o texto cru é melhor que nada
}

