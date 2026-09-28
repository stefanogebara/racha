/**
 * A COMANDA que o garçom digita ao abrir a conta — linhas de "nome, quantidade,
 * preço" viram os itens que o servidor recebe. Puro: sem React, sem rede.
 *
 * Antes a conta abria só com o TOTAL, numa linha "Total da conta": o cliente
 * não via o que consumiu e o "Por item" não tinha o que escolher (auditoria
 * e2e, 27/09/2026). O servidor sempre aceitou itens (`normalizeItems`); faltava
 * a tela.
 *
 * DINHEIRO EM CENTAVOS INTEIROS (inegociável #5): o preço unitário é lido pelo
 * mesmo `parseBrlToCents` do resto do app (passado por quem chama: este arquivo
 * não importa nada, pra rodar no `node --test` sem bundler), e o da linha é quantidade × unitário,
 * inteiro × inteiro. O nome é palavra da CASA e não se traduz; a quantidade
 * entra no nome como "(4x)", o formato que a demo já usa.
 */

export type LinhaDaComanda = { nome: string; qtd: string; preco: string };
export type ItemDaComanda = { id: string; name: string; priceCents: number };

/** O teto do servidor (`MAX_ITEMS` em check-service.js). */
export const ITENS_POR_CONTA = 200;
/** Quantidade por linha: acima disso é erro de digitação, não pedido. */
export const QTD_MAXIMA = 99;
/** O nome do item no servidor é cortado em 80; aqui o nome digitado cabe no "(99x)". */
export const NOME_MAXIMO = 72;

export const linhaVazia = (): LinhaDaComanda => ({ nome: '', qtd: '1', preco: '' });

export type ComandaLida =
  | { ok: true; itens: ItemDaComanda[]; totalCents: number }
  | { ok: false; erro: 'vazia' | 'linha_incompleta' | 'qtd_invalida' | 'preco_invalido' | 'muitos_itens' | 'servico_como_item'; linha?: number };

/**
 * O SERVIÇO NÃO É ITEM. Digitado como linha da comanda ("Serviço 10%"), ele
 * viraria consumo que o cliente não consegue tirar — e o serviço opcional ainda
 * entraria por cima: 10% travado e em dobro (inegociável #3, CDC; compliance,
 * lote 2, M-2). O serviço a casa configura uma vez; a tela soma sozinha.
 */
const PARECE_SERVICO = /servi[cç]o|gorjeta|taxa\s+de\s+servi|couvert\s+de\s+servi|\b10\s*%/i;

function linhaEmBranco(l: LinhaDaComanda): boolean {
  return l.nome.trim() === '' && l.preco.trim() === '';
}

/**
 * Lê as linhas. Linha totalmente em branco é ignorada (o campo extra que sobra
 * no fim); linha pela metade é ERRO com o número dela — um item sem preço que
 * sumisse em silêncio seria consumo que a casa não cobra.
 */
export function lerComanda(linhas: LinhaDaComanda[], parse: (s: string) => number | null): ComandaLida {
  const usadas = linhas.map((l, i) => ({ l, i })).filter(({ l }) => !linhaEmBranco(l));
  if (usadas.length === 0) return { ok: false, erro: 'vazia' };
  if (usadas.length > ITENS_POR_CONTA) return { ok: false, erro: 'muitos_itens' };
  const itens: ItemDaComanda[] = [];
  let total = 0;
  for (const { l, i } of usadas) {
    const nome = l.nome.trim();
    if (!nome || !l.preco.trim()) return { ok: false, erro: 'linha_incompleta', linha: i + 1 };
    if (PARECE_SERVICO.test(nome)) return { ok: false, erro: 'servico_como_item', linha: i + 1 };
    const qtd = /^\d+$/.test(l.qtd.trim()) ? Number(l.qtd.trim()) : NaN;
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > QTD_MAXIMA) return { ok: false, erro: 'qtd_invalida', linha: i + 1 };
    const unit = parse(l.preco);
    if (unit == null || unit <= 0) return { ok: false, erro: 'preco_invalido', linha: i + 1 };
    const priceCents = unit * qtd;
    if (!Number.isSafeInteger(priceCents)) return { ok: false, erro: 'preco_invalido', linha: i + 1 };
    total += priceCents;
    if (!Number.isSafeInteger(total)) return { ok: false, erro: 'preco_invalido', linha: i + 1 };
    itens.push({
      id: `i${itens.length + 1}`,
      name: qtd > 1 ? `${nome.slice(0, NOME_MAXIMO)} (${qtd}x)` : nome.slice(0, NOME_MAXIMO),
      priceCents,
    });
  }
  return { ok: true, itens, totalCents: total };
}

/**
 * "Chopp artesanal (4x)" → 4 unidades de R$ 13,90. Só pra MOSTRAR o unitário na
 * conta do cliente (CDC art. 6º III: dá pra conferir a conta, e "1 dos 4 chopps"
 * depende de saber o preço de um). Quando o total não divide exato pela
 * quantidade, não inventa unitário: devolve null e a linha fica como está.
 */
export function unitarioDoItem(name: string, priceCents: number): { qtd: number; unitCents: number } | null {
  const m = /\((\d{1,3})x\)\s*$/.exec(name);
  if (!m) return null;
  const qtd = Number(m[1]);
  if (qtd < 2 || !Number.isSafeInteger(priceCents) || priceCents % qtd !== 0) return null;
  return { qtd, unitCents: priceCents / qtd };
}
