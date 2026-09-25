/**
 * QUEM É A RACHA — a pessoa jurídica que opera o produto, num lugar só.
 *
 * Decidido pelo dono em 2026-09-25: a mesma empresa do Seatable ("mesma
 * empresa, mesma máquina de vendas" — CLAUDE.md), o MEI 65.087.663 Stefano Chap
 * Chap Gebara, CNPJ 65.087.663/0001-30, São Paulo/SP — o mesmo que o rodapé do
 * Seatable já publica. Nome e CNPJ cumprem o Decreto 7.962/2013 art. 2º I; o
 * inciso II pede ainda ENDEREÇO FÍSICO e CANAL ELETRÔNICO, que faltam (a cidade
 * não basta, e seatable.one não recebe e-mail) — ver TASKS (compliance, PR #38).
 *
 * Estes são dados PÚBLICOS da empresa (estão na porta e em todo recibo), não
 * dado pessoal de cliente — a regra #10 (não cruzar dado com o Seatable) é
 * sobre dado de titular, e aqui não há nenhum.
 */
import { formatTaxId } from './br';

// Os catorze dígitos, formatados AQUI MESMO — é a forma que o censo do
// documento (taxid.test.ts) aceita: constante crua sempre passada pelo
// formatador no mesmo arquivo; nem dígito solto, nem pontuação à mão.
const CNPJ_DA_RACHA = '65087663000130';

export const EMPRESA = Object.freeze({
  razaoSocial: '65.087.663 Stefano Chap Chap Gebara',
  cnpj: formatTaxId(CNPJ_DA_RACHA),   // → 65.087.663/0001-30
  cidade: 'São Paulo, SP',
});
