/**
 * OS LIMITES DAS PALAVRAS DA CASA — o mesmo número que o servidor usa.
 *
 * O nome do restaurante, o rótulo da mesa e a cidade são conferidos no servidor
 * (`api/_lib/texto-da-casa.js`) e travados no banco (migração 0035). Os
 * runtimes não compartilham módulo, então a fonte é o JSON em
 * `api/_lib/limites-da-casa.json` e `test/limites.test.ts` afirma que estes
 * números são aqueles.
 *
 * O campo do nome da casa já nasceu com `maxLength={60}` enquanto o servidor
 * aceitava outro número — cliente mais apertado que o servidor não vaza nada,
 * mas é uma regra escrita duas vezes, e é assim que a segunda envelhece.
 */
export const LIMITES = {
  nomeDaCasa: 80,
  rotuloDaMesa: 40,
  cidade: 60,
} as const;
