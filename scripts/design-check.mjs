/**
 * O DESENHO, CONFERIDO NO NAVEGADOR — porque o CSS só existe depois da cascata.
 *
 * `apps/web/test/tokens.test.ts` prova que a folha é consistente consigo mesma,
 * e `contraste.test.ts` prova que os valores declarados passam a régua. Os dois
 * leem TEXTO. O que nenhum dos dois pode responder:
 *
 *  · qual cor sai depois da cascata, da especificidade e do escopo — foi assim
 *    que a `.eyebrow` prometeu um estilo e saiu sem cor nenhuma fora da
 *    landing, porque lia um token que só existe dentro de `.landing`;
 *  · qual fonte o navegador DE FATO usou, em vez de qual foi pedida;
 *  · o que a página baixou — as oito fontes órfãs de 288 KB ficaram meses no
 *    disco sem nenhum `@font-face` citando-as;
 *  · se o campo, na tela, tem moldura que se distinga do cartão (WCAG 1.4.11)
 *    — a pergunta que motivou o `--fio-controle`.
 *
 * Então este arquivo abre um navegador de verdade, anda pelas rotas e MEDE.
 *
 * Não roda no CI por enquanto: pede um binário de navegador, que é uma decisão
 * de infra com custo próprio. Roda na máquina de quem mexe no desenho, e o
 * `RACHA_EXIGE_PLAYWRIGHT=1` transforma "não tem navegador" em FALHA em vez de
 * pulo silencioso — a mesma escotilha do `RACHA_EXIGE_PG`, pelo mesmo motivo:
 * pular é degradar aberto.
 */

import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as esperar } from 'node:timers/promises';

const EXIGIDO = process.env.RACHA_EXIGE_PLAYWRIGHT === '1';
const BASE = process.env.RACHA_DESIGN_BASE || 'http://localhost:5173';

/** As faces que a folha declara. Qualquer outra baixada é sobra. */
const FAMILIAS = ['Manrope', 'Newsreader'];
/** O que `.campo` e irmãos têm que usar: a moldura é a única coisa que diz onde se digita. */
const CAMPOS = '.campo,.namefield,.customrow,.cfggrid label';

/**
 * Um laudo por rota, medido DENTRO da página.
 *
 * Tudo que esta função devolve é medição: nada de "a regra existe", só "o que
 * saiu na tela". A diferença é a razão de o arquivo existir.
 */
const LAUDO = `async () => {
  await document.fonts.ready;
  const raiz = getComputedStyle(document.documentElement);
  const tok = (t) => raiz.getPropertyValue(t).trim();
  const rgb = (h) => { const m = h.replace('#','').match(/../g); return m ? 'rgb(' + m.map((x) => parseInt(x,16)).join(', ') + ')' : h; };
  const lum = (s) => { const p = s.match(/[\\d.]+/g).map(Number).slice(0,3).map((v) => v/255)
    .map((v) => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055) ** 2.4); return .2126*p[0] + .7152*p[1] + .0722*p[2]; };
  const cr = (a,b) => { const [x,y] = [lum(a),lum(b)].sort((p,q) => q-p); return +((x+.05)/(y+.05)).toFixed(2); };

  const CTL = rgb(tok('--fio-controle'));
  const achados = [];

  // 1. TOKENS: a paleta chegou inteira nesta rota?
  for (const t of ['--papel','--papel-alto','--ink','--grafite','--fio','--fio-controle','--rad','--rad-pill','--ui','--serif']) {
    if (!tok(t)) achados.push('token ausente: ' + t);
  }

  // 2. CAMPO: moldura regulada, e contraste medido contra a superfície em volta.
  for (const el of document.querySelectorAll(${JSON.stringify(CAMPOS)})) {
    const c = getComputedStyle(el);
    if (c.borderTopWidth === '0px') continue;
    const nome = (el.className || el.tagName).toString().slice(0, 30);
    if (c.borderTopColor !== CTL) { achados.push('campo com fio errado: ' + nome + ' -> ' + c.borderTopColor); continue; }
    const pai = el.closest('.card,.panel,.pixcard,.paid') || document.body;
    const razao = cr(c.borderTopColor, getComputedStyle(pai).backgroundColor);
    if (razao < 3) achados.push('moldura de campo abaixo de 3:1 (WCAG 1.4.11): ' + nome + ' = ' + razao + ':1');
  }

  // 3. FONTE: qual o navegador USOU, não qual foi pedida.
  const usadas = [...new Set([...document.fonts].map((f) => f.family))];
  for (const f of usadas) if (!${JSON.stringify(FAMILIAS)}.includes(f)) achados.push('face inesperada carregada: ' + f);

  // 4. O QUE A PÁGINA BAIXOU. As órfãs ficaram meses no disco sem @font-face.
  const baixadas = performance.getEntriesByType('resource')
    .map((r) => r.name).filter((u) => /\\.woff2?($|\\?)/.test(u));
  for (const u of baixadas) if (!/Manrope|Newsreader/.test(u)) achados.push('fonte fora do sistema baixada: ' + u);
  const externos = performance.getEntriesByType('resource')
    .map((r) => r.name).filter((u) => !u.startsWith(location.origin));
  for (const u of new Set(externos.map((u) => new URL(u).host))) achados.push('recurso de terceiro: ' + u);

  // 5. TOKEN DE ESCOPO VAZANDO — a classe exata do defeito da \`.eyebrow\`:
  //    uma regra que lê \`--cr2\` e casa com elemento fora de \`.landing\` promete
  //    um estilo e sai sem valor, porque o CSS descarta a propriedade em silêncio.
  const ESCOPADOS = /var\\(\\s*--(cr2|cr3|cr4|cr|n|col|u)\\b/;
  for (const folha of document.styleSheets) {
    let regras; try { regras = folha.cssRules; } catch { continue; }
    for (const r of regras) {
      if (!r.selectorText || !ESCOPADOS.test(r.cssText)) continue;
      for (const sel of r.selectorText.split(',').map((s) => s.trim())) {
        // A pergunta é LATENTE, não "existe elemento assim agora?".
        //
        // A primeira versão media \`querySelectorAll(sel)\` e pedia um elemento
        // fora de \`.landing\`. Medido contra mutante: devolver a \`.eyebrow\` ao
        // escopo global NÃO era acusado, porque os dois usos de hoje estão
        // dentro da landing — que é exatamente como o defeito original viveu,
        // latente, até alguém escrever o terceiro uso em outra tela. Um guarda
        // que só vê o defeito depois que ele machuca não é guarda.
        //
        // Então basta o SELETOR não estar preso a \`.landing\`: a regra promete
        // um estilo que, fora dali, sai sem valor nenhum.
        if (!/\\.landing\\b/.test(sel)) achados.push('lê token de escopo sem estar preso à landing: ' + sel);
      }
    }
  }

  // 6. A PÁGINA NÃO ROLA DE LADO.
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
    achados.push('rolagem horizontal: ' + document.documentElement.scrollWidth + ' > ' + document.documentElement.clientWidth);
  }

  // 7. ALVO DE TOQUE (WCAG 2.5.8). O alvo EFETIVO pode ser ampliado por
  //    \`::after\` — é o que \`.langopt\` faz —, então mede-se o maior dos dois.
  //    Sem isso, os três seletores de idioma acusariam falso.
  for (const el of document.querySelectorAll('button,a[href],[role=tab],input,select')) {
    const r = el.getBoundingClientRect(); if (!r.height) continue;
    const a = getComputedStyle(el, '::after');
    let h = Math.max(r.height, parseFloat(a.height) || 0);
    let w = Math.max(r.width, parseFloat(a.width) || 0);
    // O RÓTULO TAMBÉM É O ALVO. Uma caixa de seleção dentro de um \`<label>\`
    // é acionada por qualquer ponto do rótulo — medir só a caixinha de 18px
    // acusa o inocente, e um medidor que acusa o inocente morre igual a um que
    // absolve o culpado: a equipe aprende a ignorar o vermelho.
    //
    // Achado medindo a PRODUÇÃO: o "serviço (10%) — opcional", que é o
    // controle que o inegociável #3 exige que seja removível, tem caixa de
    // 18x18 e rótulo de 348x42. Conferido clicando no texto e vendo o estado
    // virar — e não por leitura.
    const rotulo = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]'));
    if (rotulo) { const rr = rotulo.getBoundingClientRect(); h = Math.max(h, rr.height); w = Math.max(w, rr.width); }
    if (h < 24 || w < 24) achados.push('alvo menor que 24px: ' + (el.textContent || el.tagName).trim().slice(0, 24) + ' = ' + Math.round(w) + 'x' + Math.round(h));
  }

  return { achados, faces: usadas.sort(), campos: document.querySelectorAll(${JSON.stringify(CAMPOS)}).length };
}`;

async function medir(pagina, rota) {
  await pagina.goto(BASE + rota, { waitUntil: 'networkidle' }).catch(() => pagina.goto(BASE + rota));
  await esperar(600);
  // `(fn)()` e não `fn`: com uma STRING, o Playwright avalia a expressão e
  // devolve o VALOR dela — passar só a arrow devolvia a função, não o laudo.
  const r = await pagina.evaluate(`(${LAUDO})()`);
  return { rota, ...r };
}

async function principal() {
  let navegador;
  try {
    navegador = await chromium.launch();
  } catch (e) {
    const recado = `sem navegador do Playwright (${String(e.message).split('\n')[0]}) — `
      + 'rode `npx playwright install chromium`';
    if (EXIGIDO) { console.error(`RACHA_EXIGE_PLAYWRIGHT=1 e ${recado}`); process.exit(1); }
    console.error(`PULADO: ${recado}`);
    process.exit(0);
  }

  // As rotas vêm do ambiente porque os tokens do demo mudam a cada boot do
  // `dev-server.js` — ele os imprime no start.
  const ROTAS = (process.env.RACHA_DESIGN_ROTAS || '/,/carteira,/painel,/admin,/qrs').split(',');
  const pagina = await navegador.newPage({ viewport: { width: 430, height: 900 } });
  const erros = [];
  pagina.on('console', (m) => { if (m.type() === 'error') erros.push(`[${'console'}] ${m.text().slice(0, 120)}`); });

  const laudos = [];
  for (const rota of ROTAS) laudos.push(await medir(pagina, rota));
  await navegador.close();

  let falhou = false;
  for (const l of laudos) {
    const marca = l.achados.length ? '✗' : '✓';
    console.log(`${marca} ${l.rota.padEnd(28)} ${String(l.campos).padStart(2)} campo(s)  faces: ${l.faces.join(', ') || '—'}`);
    for (const a of l.achados) { console.log(`    · ${a}`); falhou = true; }
  }
  for (const e of erros) { console.log(`✗ ${e}`); falhou = true; }
  console.log(falhou ? '\nDESENHO: achados acima.' : '\nDESENHO: sem achados.');
  process.exit(falhou ? 1 : 0);
}

principal();
