import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reciboVista } from '../src/recibo.ts';

const SEM: never[] = [];
const vista = (paga: string | null, viva: string | null, falta: number) =>
  reciboVista(paga, viva, falta, SEM, null);

test('mesma conta: progresso, e "pagar mais" só se ainda falta', () => {
  assert.deepEqual(vista('c1', 'c1', 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false, avisos: [] });
  assert.deepEqual(vista('c1', 'c1', 0), { mostrarProgresso: true, oferecerMais: false, contaTrocou: false, avisos: [] });
});

test('A CONTA TROCOU: nada de progresso alheio, nada de "pagar mais"', () => {
  // O caso que importa. Numa casa de verdade, `c2` é a conta da PRÓXIMA mesa no
  // mesmo QR — e `falta` é o que os OUTROS devem, com R$ 237,10 inteiros.
  // Oferecer "pagar mais" aqui era um toque até um Pix real pela comida dos
  // outros.
  assert.deepEqual(vista('c1', 'c2', 23710), { mostrarProgresso: false, oferecerMais: false, contaTrocou: true, avisos: [] });
});

test('antes de gravar a conta paga, o comportamento é o de sempre', () => {
  // O primeiro render depois do pagamento ainda não gravou a conta: não pode
  // esconder nada nem congelar — a conta é, por definição, a mesma.
  assert.deepEqual(vista(null, 'c1', 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false, avisos: [] });
});

test('conta viva ausente (404 no poll) não é "trocou"', () => {
  // O `catch` do poll mantém a view antiga; se algum dia ele passar a limpar,
  // ausência não pode virar troca — senão um 404 passageiro congelaria o recibo.
  assert.deepEqual(vista('c1', null, 5000), { mostrarProgresso: true, oferecerMais: true, contaTrocou: false, avisos: [] });
});

/**
 * OS AVISOS DE DINHEIRO SÃO DA CONTA PAGA — e a primeira versão deixava de fora.
 *
 * `reciboVista` escondia o progresso e o "pagar mais" quando a conta trocava,
 * mas os avisos (a casa te deve R$ X) eram lidos direto do `state` vivo, sem
 * passar por aqui. As duas revisões acharam; a de segurança mediu no navegador:
 * quem tinha R$ 50 a receber perdia o aviso na troca, e com o poll atrasado o
 * recibo congelado mostrava "Esta conta recebeu R$ 7,77 a mais" — sobre a mesa
 * dos OUTROS. O aviso existe pra exatamente este caso (CDC art. 6º III): a
 * pessoa vai embora sem saber que tem valor a receber.
 */
const PAGO_A_MAIS = [{ code: 'overpaid_pending_restitution' as const, amountCents: 5000 }];
const DA_OUTRA_MESA = [{ code: 'overpaid_pending_restitution' as const, amountCents: 777 }];

test('mesma conta: os avisos são os vivos (um estorno pode chegar depois)', () => {
  assert.deepEqual(reciboVista('c1', 'c1', 0, PAGO_A_MAIS, null).avisos, PAGO_A_MAIS);
});

test('CONTA TROCOU: o aviso da conta paga fica; o da outra mesa não entra', () => {
  // O que a pessoa tem a receber continua na tela…
  assert.deepEqual(reciboVista('c1', 'c2', 0, DA_OUTRA_MESA, PAGO_A_MAIS).avisos, PAGO_A_MAIS);
  // …e o que é da mesa de outra pessoa nunca aparece no recibo dela.
  assert.deepEqual(reciboVista('c1', 'c2', 0, DA_OUTRA_MESA, null).avisos, []);
});

/**
 * E A TELA DE "PAGO" SÓ LÊ AVISO PELA DECISÃO — um censo, porque o teste da
 * função pura sozinho não prendia a FIAÇÃO.
 *
 * Foi exatamente assim que a primeira versão falhou: `reciboVista` estava
 * certa e testada, e a linha dos avisos no JSX lia `state.notices` direto, por
 * fora dela. Nenhum teste da função pura teria visto. A revisão de segurança
 * pediu isto por nome.
 */
test('o ramo "pago" do App lê os avisos por `recibo.avisos`, nunca por `state.notices`', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const fonte = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
  const ini = fonte.indexOf("if (step === 'pago') {");
  assert.ok(ini > 0, 'o ramo `pago` não foi achado — o censo quebrou, não o App');
  // O ramo termina no próximo `if (step ===` de nível de componente.
  const fim = fonte.indexOf("\n  if (", ini + 10);
  const ramo = fonte.slice(ini, fim > ini ? fim : undefined);
  assert.ok(ramo.includes('recibo.avisos'), 'o ramo `pago` não usa `recibo.avisos` — a prova ficaria vazia');
  // `state.notices` PODE entrar como argumento da decisão — é a entrada dela.
  // A primeira versão deste censo proibia qualquer ocorrência e acusou
  // justamente a fiação certa: uma regra que acusa o inocente é apagada pelo
  // próximo, com razão. O proibido é ler fora da decisão.
  const semADecisao = ramo.replace(/reciboVista\([^;]*\);/, '');
  assert.equal(/state\.notices/.test(semADecisao), false,
    'o ramo `pago` lê `state.notices` por fora de `reciboVista`: quando a conta troca, o recibo mostra o aviso da mesa dos OUTROS');
});
