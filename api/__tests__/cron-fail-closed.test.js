'use strict';

/**
 * Toda rota de cron que ESCREVE falha fechada sem `CRON_SECRET`.
 *
 * A rota da retenção nasceu copiando a forma errada. Há duas neste arquivo:
 * o `activation-radar` só LÊ, então sem segredo ele cai num limite de taxa e
 * responde; o `reconcile` ESCREVE, e o commit `4930caa` já o tinha reescrito
 * pra devolver 503 e paginar, porque "degradar aberta era divulgação
 * cross-tenant sem auth". Eu copiei a primeira e a retenção virou um `curl`
 * anônimo disparando UPDATE de tabela inteira sem índice e devolvendo a
 * contagem de sessões de cliente da plataforma toda.
 *
 * O teste que existia era `expect(rota).toMatch(/segredoConfere\(…\)/)` — um
 * censo de substring que passa numa rota onde essa chamada mora DENTRO de
 * `if (process.env.CRON_SECRET)`. Ele prova que o portão existe, não que
 * alguma entrada faça o portão RODAR.
 *
 * Isto enumera as rotas de cron, classifica cada uma por escrever ou não, e
 * exige a forma certa de cada classe. Achado da revisão de segurança de
 * 2026-09-12.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '_app', 'router.js'), 'utf8');

/** Os corpos das rotas `/api/cron/*`, na ordem em que aparecem. */
function rotasDeCron() {
  const marcas = [...SRC.matchAll(/url\.pathname === '(\/api\/cron\/[a-z-]+)'/g)]
    .map((m) => ({ nome: m[1], inicio: m.index }));
  return marcas.map((m, i) => ({
    nome: m.nome,
    corpo: SRC.slice(m.inicio, i + 1 < marcas.length ? marcas[i + 1].inicio : SRC.length),
  }));
}

/**
 * ESCREVE por padrão. A lista é de LEITORES, e é nominal.
 *
 * A primeira versão perguntava "esta rota chama algum `store.<verbo>`?" — uma
 * lista de negação sobre uma convenção de chamada. E o cron que mais escreve do
 * arquivo escreve através de `reconciler.reconcile(...)` e de `writeBackToPos`,
 * nenhum dos dois casando: o censo escrito pra pegar rota aberta classificou a
 * mais aberta como leitura. Censo que afirma cobertura que não tem é pior que
 * censo nenhum, e isso já está escrito no registro de decisões deste repo.
 *
 * Então a pergunta inverteu: rota de cron ESCREVE, a menos que alguém a tenha
 * declarado leitora aqui, por nome, com o motivo. Uma rota nova reprova o teste
 * até ser classificada — que é o único jeito de falhar fechado contra um padrão
 * de chamada que ninguém previu.
 */
const SO_LEEM = new Map([
  ['/api/cron/activation-radar', 'monta o radar a partir de `listVenueActivation` e responde; não grava'],
]);

function escreve(nome) {
  return !SO_LEEM.has(nome);
}

/**
 * Rotas SEM portão que mandam coisa pra fora, com o motivo escrito. Cada uma é
 * uma decisão, não um resto.
 */
const SAIDA_SEM_PORTAO = {
  '/api/demo/beacon': (
    'TELEMETRIA DE PROSPECÇÃO, e ela TEM que ser pública: quem a dispara é o '
    + '`sendBeacon` do navegador de um prospecto abrindo o link da Olímpia, que por '
    + 'definição não tem sessão. O que está bounded e escrito: (a) limite de taxa da '
    + 'demo, 30 por janela de 10 min por IP; (b) o corpo aceito é DOIS campos — um '
    + '`event` de lista FECHADA (`opened`/`paid`) e um `pl` que é só CONFERIDO NO '
    + 'TAMANHO (40 a 400 caracteres, conteúdo livre) —, e nada disso é lido como '
    + 'instrução; (c) a rota devolve 200 fixo, sem repassar nada do outro lado, '
    + 'então não vira oráculo de token válido PELO CORPO. O que ela não impede, e '
    + 'está dito por inteiro: (1) o `pl` segue server-side pro `/api/previa-event` '
    + 'da Olímpia e É ESCRITO na linha do tempo de prospecção de lá — não é um '
    + 'no-op, é gravação num sistema nosso, e quem já tem um link de prospecção '
    + 'válido pode forjar evento PARA AQUELE LINK e sujar o radar de vendas; (2) o '
    + '`fetch` é AGUARDADO com prazo de 4s, então o tempo de resposta desta rota '
    + 'mede a ponte — é um oráculo de LATÊNCIA, mesmo com o corpo mudo, e também '
    + 'uma amplificação: 30 requisições por IP por janela viram 30 chamadas '
    + 'server-side e até 120 segundos-função por IP; (3) o próprio limite é fraco '
    + 'por construção — `openBuckets` é estado de MÓDULO numa função serverless '
    + '(cada instância fria tem o seu), `clientIp` confia no `x-real-ip` quando '
    + 'presente, e o `clear()` de contenção de memória zera os baldes de TODO '
    + 'mundo aos 10 mil. O que NÃO está exposto em nenhum desses caminhos: '
    + 'dinheiro, o cliente na mesa, dado pessoal do diner. A validação do `pl` é '
    + 'da ponte, que é quem o emitiu; aqui ele é repassado, nunca confiado. '
    + 'Achado pelo censo de saída ao varrer o router inteiro (2026-09-14) e '
    + 'corrigido nos três pontos acima pela revisão de segurança de 2026-09-15.'
  ),
  '/api/check': (
    'A LEITURA PÚBLICA DA CONTA, e as duas chamadas de saída que ela dispara são '
    + 'de CURA, não de efeito: quando o estado derivado do razão diverge da linha '
    + 'de `payments`, a rota chama `reconciler.reconcile({ checkId })` (que fala '
    + 'com o PSP pra reconferir a cobrança) e `writeBackToPos(checkId)` (que '
    + 'empurra o pago pro POS). Não tem portão porque não PODE ter: quem lê é o '
    + 'telefone do cliente na mesa, sem login, com um token de mesa — e o '
    + 'inegociável #9 diz browser-only, sem download e sem login. E não tem limite '
    + 'de taxa por decisão medida, escrita no docblock do `registraMissDeCheck`: o '
    + 'telefone consulta a cada 4s, um salão inteiro é UM ip atrás do NAT do '
    + 'restaurante, e o limite fecharia a conta na cara do segundo cliente. O que '
    + 'segura o abuso, e é ESTRANGULAMENTO, não sorte: o `shouldReconcileNow(checkId)` '
    + 'limita a chamada por conta, o ramo inteiro só existe quando ainda se deve '
    + 'dinheiro (`paidCents < totalCents`) — conta sã não chama nada — e o '
    + '`writeBackToPos` só sai quando o `reconcile` confirmou alguma coisa '
    + '(`r.confirmed > 0`). O teto real do abuso é um chamador com token de mesa '
    + 'válido e conta em aberto forçando um `reconcile` a cada 10 segundos pro '
    + 'adquirente daquele restaurante — com a mesma ressalva do beacon escrita por '
    + 'inteiro: `reconcileThrottle` é `Map` de MÓDULO numa função serverless, então '
    + 'cada instância fria tem o seu e o `clear()` de contenção de memória zera o de '
    + 'todas as contas aos 5 mil. Declarado, não descoberto: era exatamente o '
    + 'que a v2 deste censo não via, porque procurava `fetch(` e `notify*(` e '
    + 'saída por ADAPTADOR não casa nenhum dos dois. Achado pela revisão de '
    + 'segurança de 2026-09-15.'
  ),
  '/api/pay': (
    'CRIA COBRANÇA NO ADQUIRENTE, e é pública por desenho: quem paga é o '
    + 'telefone do cliente na mesa, com um token de mesa e sem login '
    + '(inegociável #9). O que a segura: `getCheckByQrToken` exige token de mesa '
    + 'com conta ABERTA; o `create-charge` recusa valor acima do que resta '
    + '(`amount_over`), então a soma das cobranças de uma conta é limitada pelo '
    + 'total dela; o `chargeRef` é determinístico '
    + '(`checkId:paidCents:amountCents:tipCents`), então a mesma requisição '
    + 'repetida pede a mesma cobrança; e o `marketGate` fecha o trilho fora do '
    + 'mercado ligado. O QUE ELA NÃO IMPEDE, e está dito: quem tem um token de '
    + 'mesa — que viaja em QR fotografado e em link compartilhado — pode abrir '
    + 'N cobranças PENDENTES de valor pequeno, uma por requisição, e cada uma é '
    + 'uma cobrança viva na conta da casa no adquirente. Não há limite de taxa '
    + 'nesta rota nem teto de pendentes por conta. O teto de VALOR existe; o de '
    + 'CONTAGEM não. Apontado pela revisão de segurança de 2026-09-15 (HIGH-1); '
    + 'declarado aqui porque fechá-lo é mudança no caminho do dinheiro e passa '
    + 'pelo portão de duas assinaturas, não pelo fim de uma sessão.'
  ),
  '/api/pay/stripe-intent': (
    'O MESMO, no trilho da Stripe (Bizum e carteira). Mesma exposição e mesmas '
    + 'defesas do `/api/pay`, porque os dois entram no mesmo `create-charge` e '
    + 'no mesmo `marketGate`: token de mesa com conta aberta, teto de valor pelo '
    + 'que resta, `chargeRef` determinístico. E a mesma lacuna: sem limite de '
    + 'taxa e sem teto de PaymentIntents pendentes por conta. Fica na mesma '
    + 'decisão que a rota irmã — um teto de pendentes por conta vale mais que um '
    + 'limite por IP, porque um salão inteiro é um IP só atrás do NAT do '
    + 'restaurante, que é a aritmética que já está escrita no `registraMissDeCheck`.'
  ),
  '/api/house/load': (
    'CARGA DE SALDO DA CASA: também cria cobrança, e o portador aqui é o '
    + '`accountToken` da conta de saldo, não o token da mesa. O `houseSvc` '
    + 'resolve o portador e 404 se ele não existir, então não é anônima — mas '
    + 'não tem portão de SESSÃO, e o censo está certo em não contar um portador '
    + 'como autenticação de rota. O que a segura, além do portador: o portão de '
    + 'mercado do saldo da casa (`house_off` por venue) e o mesmo `create-charge` '
    + 'das outras duas. A mesma lacuna de CONTAGEM de pendentes se aplica, com '
    + 'um agravante honesto: o valor da carga não é limitado por uma conta '
    + 'aberta, porque carga de saldo não tem conta pra limitar. Apontado pela '
    + 'revisão de segurança de 2026-09-15.'
  ),
};

/**
 * A saída que mora FORA de qualquer rota, declarada por trecho de linha.
 *
 * Não é uma dispensa em bloco: cada entrada casa o começo de UMA linha, então
 * declarar uma não absolve a próxima. Hoje são as duas leituras de cobrança do
 * `confirmDeps`, que é o helper de escopo de módulo que o aplicador de webhook
 * recebe — elas não são alcançáveis por rota nenhuma diretamente.
 */
const SAIDA_FORA_DE_ROTA = [
  // As duas leituras de cobrança do `confirmDeps`, o helper que o aplicador de
  // webhook recebe — não alcançáveis por rota diretamente.
  'if (stripePsp && typeof txid',
  'return typeof psp.getCharge',
  // E as DEFINIÇÕES dos próprios embrulhos de saída. Um censo que lê nomes não
  // distingue definir de chamar, e a linha que define `writeBackToPos` casa o
  // nome `writeBackToPos`. Declarar a definição é honesto; o que importa são
  // as CHAMADAS, e essas moram dentro de rota.
  'async function writeBackToPos(',
  'process.stderr.write(`writeBackToPos(',
  'async function avisarEventoDeDinheiro(',
  'return await notifyFounderMoneyEvent(',
];

describe('cron: quem escreve não degrada aberta', () => {
  const rotas = rotasDeCron();

  test('há rotas de cron pra examinar', () => {
    expect(rotas.length).toBeGreaterThanOrEqual(4);
  });

  test('todo cron AGENDADO é classificado — a enumeração vem do vercel.json', () => {
    // A enumeração era por prefixo `/api/cron/`, e `/api/demo/reset` está
    // agendado como cron, escreve (fecha e abre conta na mesa de demo) e não
    // segue a convenção de nome — então era invisível pro censo. Ser público é
    // decisão tomada; ser INCLASSIFICÁVEL não é.
    const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'vercel.json'), 'utf8'));
    const agendados = (vercel.crons || []).map((c) => c.path);
    expect(agendados.length).toBeGreaterThan(0);

    // Exceção NOMEADA, com o motivo — não um buraco na regex.
    const EXCECOES = new Map([
      ['/api/demo/reset', 'mesa pública de demonstração: dinheiro do MockPsp, '
        + 'protegida por rateLimitDemo e por resolveDemoTable; nunca toca casa real'],
    ]);

    const semClassificacao = agendados.filter(
      (p) => !EXCECOES.has(p) && !rotas.some((r) => r.nome === p),
    );
    expect(semClassificacao).toEqual([]);
  });

  test('toda rota de cron que escreve exige CRON_SECRET e devolve 503 sem ele', () => {
    const frouxas = [];
    for (const r of rotas) {
      if (!escreve(r.nome)) continue;
      // A forma que importa: a AUSÊNCIA do segredo é tratada explicitamente e
      // fecha. `if (process.env.CRON_SECRET) { … }` sem `else` que feche não
      // conta — era exatamente essa a forma frouxa.
      // Janela larga: entre o `if` e o 503 cabem o log, o aviso ao fundador e
      // o comentário que explica por que a rota fecha. O que importa é que o
      // ramo da AUSÊNCIA do segredo termine em 503, não a distância.
      const fechaSemSegredo = /if \(!process\.env\.CRON_SECRET\)[\s\S]{0,1600}?json\(res, 503/.test(r.corpo);
      if (!fechaSemSegredo) frouxas.push(r.nome);
    }
    expect(frouxas).toEqual([]);
  });

  test('nenhum ramo SEM autenticação manda nada pra fora', () => {
    /**
     * O CENSO QUE FALTAVA, e ele fecha a CLASSE em vez do caso.
     *
     * Este arquivo provava que a rota FECHA sem o segredo; não provava que ela
     * não produz EFEITO EXTERNO antes de fechar. A `/api/cron/reconcile`
     * paginava o fundador de dentro do ramo `!process.env.CRON_SECRET` — que é,
     * por definição, o ramo sem autenticação: é o ramo do segredo ausente. O
     * throttle era `let` de módulo numa função serverless, então todo cold
     * start o zerava, e N requisições concorrentes rendiam N avisos e N
     * `fetch` de 8 segundos. Amplificação de function-seconds e telefone do
     * fundador, por `curl` anônimo.
     * Achado pela revisão de segurança de 2026-09-14.
     *
     * A regra: entre o `if (!process.env.CRON_SECRET)` e o `return` dele não
     * pode haver chamada de saída. Log em stderr pode — é local, é grátis, e é
     * o que as outras duas rotas de cron sempre fizeram.
     */
    const sujas = [];
    // ROTA QUE O CENSO NÃO SABE LER NÃO PODE SER PULADA. A primeira versão
    // exigia a chave de fechamento com SEIS espaços exatos e fazia `continue`
    // quando não achava: uma rota aninhada um nível a mais, ou escrita sem
    // chaves, saía do censo em silêncio — a forma "guarda que nunca dispara"
    // dentro do censo escrito pra fechar essa forma. Apontado pela revisão de
    // segurança de 2026-09-14.
    const naoParseadas = [];
    for (const r of rotas) {
      if (!/if \(!process\.env\.CRON_SECRET\)/.test(r.corpo)) continue;
      const m = /if \(!process\.env\.CRON_SECRET\)\s*\{([\s\S]*?)\n\s*\}/.exec(r.corpo);
      if (!m) { naoParseadas.push(r.nome); continue; }
      if (/notify[A-Za-z]*\(|await fetch\(|sendMail|webhook/.test(m[1])) sujas.push(r.nome);
    }
    expect(naoParseadas).toEqual([]);
    expect(sujas).toEqual([]);
  });

  /**
   * O CENSO DE SAÍDA, POR SUPERFÍCIE — e é a terceira versão dele.
   *
   * A v1 só olhava dentro do ramo `if (!process.env.CRON_SECRET)`, porque foi
   * escrita a partir do achado que a criou; uma rota que não é cron e manda
   * coisa pra fora sem autenticação era invisível por construção, e havia uma
   * (`/api/demo/beacon`). A v2 passou a varrer o router inteiro procurando
   * `notify*(` e `await fetch(` — e a mesma forma se repetiu um nível acima: a
   * lista de EXPRESSÕES veio dos dois achados que a criaram. A revisão de
   * segurança de 2026-09-15 mostrou cinco formas que ela não vê e duas
   * chamadas VIVAS que ela não via:
   *
   *  · `fetch` sem `await` — `void fetch(x)`, `fetch(x).catch(…)`,
   *    `Promise.all([fetch(a)])`. E fire-and-forget é exatamente como a próxima
   *    telemetria vai ser escrita.
   *  · saída através de ADAPTADOR: `reconciler.reconcile` fala com o PSP,
   *    `writeBackToPos` fala com o POS, `psp.getCharge` fala com o gateway. É
   *    onde TODO o tráfego de dinheiro mora, e nenhuma dessas casa `fetch(`.
   *  · `/api/check` — pública, sem autenticação e deliberadamente sem limite de
   *    taxa (a aritmética está escrita no próprio router) — chama as duas
   *    primeiras. Um chamador com um token de mesa válido e uma conta em aberto
   *    dirige tráfego pra adquirente e pro POS.
   *  · seis call sites de aviso de dinheiro (`avisarEventoDeDinheiro`,
   *    `handleNonLedgerMoneyEvent`) sobre os quais a v2 não afirmava nada.
   *
   * Então a pergunta inverte, como o `SO_LEEM` já faz neste arquivo: enumera-se
   * a SUPERFÍCIE de saída — os nomes que alcançam a rede — e exige-se que toda
   * rota que chega a um deles esteja num portão ou declarada. Nome novo de
   * saída entra na lista ou o censo não o vê; é a mesma troca que o `SO_LEEM`
   * fez, e ela é honesta porque a lista é curta e mora ao lado do código.
   */
  const SUPERFICIE_DE_SAIDA = [
    'notifyOwnerRecipientStatus', 'notifyFounderActivationRadar', 'notifyPreviaBeacon',
    'notifyFounderReconcile', 'notifyFounderMoneyEvent', 'avisarEventoDeDinheiro',
    'handleNonLedgerMoneyEvent', 'writeBackToPos', 'fetch',
  ];

  /**
   * E A SAÍDA QUE NÃO TEM NOME PRÓPRIO: chamada de MÉTODO num singleton.
   *
   * A v3 listava `reconciler.reconcile`, `psp.getCharge` e `stripePsp.getCharge`
   * — três nomes, todos do lado da LEITURA. A revisão de segurança de
   * 2026-09-15 mostrou que a lista tinha vindo, outra vez, dos achados que a
   * criaram: a CRIAÇÃO de cobrança estava inteira de fora. `/api/pay` (pública,
   * token de mesa, SEM limite de taxa) chama `charge(...)`, que é
   * `psp.createPixCharge`; `/api/pay/stripe-intent` chama
   * `stripePsp.createBizumCharge`/`createWalletCharge`; `/api/house/load` chama
   * `houseSvc.createLoad`, que também cria cobrança. Cada requisição vira uma
   * cobrança viva na conta da casa no adquirente.
   *
   * Então aqui a enumeração é de SINGLETON, não de método: qualquer membro de
   * `psp`, `stripePsp`, `demoPsp` ou `reconciler` conta. Método novo no
   * adaptador entra coberto sem ninguém lembrar — que é a diferença entre esta
   * forma e as três anteriores, todas listas de nomes.
   */
  const SINGLETONS_DE_SAIDA = [
    String.raw`(?:psp|stripePsp|demoPsp|reconciler)\.[A-Za-z]`,
    String.raw`(?:demoCharge|charge)\s*[):]`,
    String.raw`houseSvc\.(?:createLoad|redeem)\(`,
  ];

  // `fetch` é nome da PLATAFORMA, não símbolo do repositório: hoje o router não
  // o chama direto (toda saída passa por `_lib/notify.js` ou por um adaptador),
  // e é justamente por isso que ele fica na lista — o dia em que alguém escrever
  // `void fetch(...)` aqui, o censo já está olhando. Os outros nomes são do
  // repositório e têm que existir: lista que não descreve o código de hoje é
  // lista que passa calada.
  const UNIVERSAIS = new Set(['fetch']);
  const reSaida = new RegExp([
    ...SUPERFICIE_DE_SAIDA.map((n) => `${n.replace('.', '\\.')}\\s*\\(`),
    ...SINGLETONS_DE_SAIDA,
  ].join('|'));

  test('a superfície de saída declarada ainda existe no router', () => {
    const perdidos = SUPERFICIE_DE_SAIDA
      .filter((n) => !UNIVERSAIS.has(n))
      .filter((n) => !SRC.includes(`${n}(`));
    expect(perdidos).toEqual([]);
    // E os singletons também: enumeração que não descreve o código de hoje
    // passa calada, e a forma "regex que nunca casa" é a mais calada de todas.
    const sumidos = SINGLETONS_DE_SAIDA.filter((r) => !new RegExp(r).test(SRC));
    expect(sumidos).toEqual([]);
  });

  test('toda rota que alcança a superfície de SAÍDA tem portão, ou é declarada', () => {
    const fonte = SRC.split('\n');
    /**
     * Fronteira de rota: qualquer comparação de `url.pathname`.
     *
     * A versão anterior desta linha exigia um ESPAÇO literal depois de
     * `url.pathname`, então as três alternativas que ela acabara de ganhar
     * (`.startsWith(`, `.endsWith(`, `.match(`) nunca casavam nada — código
     * real é `url.pathname.startsWith('/api/x')`, sem espaço. A correção
     * anunciada no commit não existia. Achado pela revisão de segurança de
     * 2026-09-15.
     *
     * E só conta como rota NOVA o caminho absoluto: `url.pathname.endsWith('refund')`
     * (router.js:1238) é um sub-ramo DENTRO de uma rota já aberta, e tratá-lo
     * como fronteira trocaria o nome da rota no relatório e zeraria o portão
     * dela no meio do corpo.
     */
    const ROTA = /url\.pathname\s*(?:===|\.startsWith\(|\.endsWith\(|\.match\()\s*'(\/[^']*)'/;
    /**
     * O portão tem que RODAR, não aparecer.
     *
     * A versão anterior aceitava `accountToken` e `DEMO_MODE` nus. O primeiro
     * casa `accountToken: b.accountToken` — uma chave de objeto a caminho do
     * serviço, que não valida nada; o segundo casa qualquer linha que cite a
     * constante. Duas rotas inventadas pela revisão de segurança passaram com
     * um deles no meio e nenhuma autenticação. Agora cada token é uma CHAMADA
     * ou uma condição: `getHouseAccountByToken(` é quem resolve o portador e
     * 404 se não existir; `if (DEMO_MODE` é a guarda, não a menção.
     *
     * Limite conhecido e dito: isto vê o portão APARECER antes da saída, não vê
     * ele RODAR — a forma "portão opcional" (`if (cfg) { ...checa... }`) passa.
     * É o preço de um censo textual; o que ele compra é que portão nenhum pode
     * sumir em silêncio.
     */
    const PORTAO = new RegExp([
      'segredoConfere\\(', 'requireOwner\\(', 'exigeDono\\(', 'sessaoDoDono\\(',
      'guardUser\\(', 'verifySignature\\(', 'verifyAndParseWebhook', 'handleWebhook\\(',
      'getHouseAccountByToken\\(', 'houseSvc\\.redeem\\(', 'if \\(DEMO_MODE',
      'podeEnviarAviso\\(',
    ].join('|'));
    // `/**` é início de bloco de comentário e a v2 o lia como código.
    const comentario = (l) => /^\s*(\/\*|\*|\/\/)/.test(l);
    /**
     * FORA DE ROTA TAMBÉM É UM LUGAR.
     *
     * `rota` nunca era zerada, então tudo depois do último `if` de rota — o
     * `catch (err)` que TODA rota atravessa — herdava o portão da última. Um
     * aviso ao fundador plantado no log de 500 (`router.js:2186`) passava
     * limpo: página disparável por qualquer requisição anônima que produza 500
     * em qualquer rota, que é exatamente a amplificação que a v1 deste censo
     * nasceu pra fechar, mudada de lugar. E o escopo de MÓDULO, acima da
     * primeira rota, era pulado inteiro.
     *
     * As rotas moram em indentação 4 dentro do `try`; qualquer linha com menos
     * que isso saiu delas. O que está fora tem que estar declarado por NOME de
     * saída, não em bloco — senão a declaração absolve o módulo inteiro.
     * Achado pela revisão de segurança de 2026-09-15.
     */
    let rota = null; let temPortao = false;
    const soltas = []; const foraDeRota = [];
    for (const l of fonte) {
      const m = ROTA.exec(l);
      if (m) { rota = m[1]; temPortao = false; } else if (/^ {0,3}\S/.test(l)) { rota = null; }
      if (comentario(l)) continue;
      if (rota && PORTAO.test(l)) temPortao = true;
      if (!reSaida.test(l)) continue;
      if (!rota) { foraDeRota.push(l.trim().slice(0, 60)); continue; }
      if (!temPortao) soltas.push(rota);
    }
    expect([...new Set(soltas)].filter((r) => !SAIDA_SEM_PORTAO[r])).toEqual([]);
    for (const [r, porque] of Object.entries(SAIDA_SEM_PORTAO)) {
      expect(`${r}: ${porque}`).toMatch(/.{200,}/);
      expect(soltas).toContain(r);
    }
    expect(foraDeRota.filter((t) => !SAIDA_FORA_DE_ROTA.some((d) => t.startsWith(d)))).toEqual([]);
    for (const d of SAIDA_FORA_DE_ROTA) {
      expect(foraDeRota.some((t) => t.startsWith(d))).toBe(true);
    }
  });

  test('toda declaração aponta pra código que existe', () => {
    /**
     * Prosa de gaveta é medida por tamanho (`.{200,}`) e por nada mais, e a
     * primeira versão da declaração da `/api/check` citava uma função
     * `rateLimitCheck` que não existe em lugar nenhum do repositório — a
     * aritmética está no docblock do `registraMissDeCheck`. Quem seguisse o
     * ponteiro não achava nada e teria que decidir sozinho se a decisão fora
     * medida. Mesma forma do `_porque` que descrevia uma remoção que não
     * aconteceu. Achado pela revisão de segurança de 2026-09-15.
     */
    // O alvo é o router MAIS a biblioteca: uma declaração de rota fala do
    // serviço que ela chama (`house_off` mora no `house-service.js`), e exigir
    // que tudo esteja no router transformaria a checagem numa proibição de
    // citar o código certo.
    const lib = path.join(__dirname, '..', '_lib');
    const arquivos = fs.readdirSync(lib, { recursive: true })
      .map((f) => String(f))
      .filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(lib, f), 'utf8'));
    const universo = [SRC, ...arquivos].join('\n');
    const faltando = [];
    for (const [rota, porque] of Object.entries(SAIDA_SEM_PORTAO)) {
      for (const m of porque.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) {
        if (!universo.includes(m[1])) faltando.push(`${rota}: ${m[1]}`);
      }
    }
    expect(faltando).toEqual([]);
    // E a checagem tem que estar mordendo: um nome inventado falha.
    expect(universo.includes('rateLimitCheck')).toBe(false);
  });

  test('nenhuma rota de cron que escreve cai num limite de taxa como alternativa', () => {
    // `else if (!rateLimitCron(req))` era o caminho que deixava a rota pública.
    const comEscape = rotas
      .filter((r) => escreve(r.nome))
      .filter((r) => /else if \(!rateLimitCron\(req\)\)/.test(r.corpo))
      .map((r) => r.nome);
    expect(comEscape).toEqual([]);
  });
});
