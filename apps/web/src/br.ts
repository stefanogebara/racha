/**
 * Validação e formatação brasileira — CPF/CNPJ (com dígito verificador),
 * bancos, e máscaras. Puro e testável (br.test.ts). Usado no wizard de setup
 * pra validar os dados ANTES de mandar pro Pagar.me (que também valida a conta
 * na criação do recebedor — aqui é a primeira barreira, pega o typo na hora).
 */

export function onlyDigits(s: string): string {
  return String(s || '').replace(/\D/g, '');
}

/** Dígito verificador pode ser letra em alguns bancos (ex.: conta 'X' do BB). */
export function alnum(s: string): string {
  return String(s || '').replace(/[^0-9a-zA-Z]/g, '');
}

/** CPF: 11 dígitos + os dois dígitos verificadores conferem (pega quase todo typo). */
export function isValidCPF(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false; // 000... , 111... etc.
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

/** CNPJ: 14 dígitos + os dois dígitos verificadores conferem. */
export function isValidCNPJ(input: string): boolean {
  const d = onlyDigits(input);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number) => {
    const weights = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export type DocKind = 'cpf' | 'cnpj' | null;

/** 11 dígitos → cpf, 14 → cnpj, senão null (ainda incompleto/ inválido de tamanho). */
export function docKind(input: string): DocKind {
  const n = onlyDigits(input).length;
  if (n === 11) return 'cpf';
  if (n === 14) return 'cnpj';
  return null;
}

export function isValidCpfCnpj(input: string): boolean {
  const k = docKind(input);
  return k === 'cpf' ? isValidCPF(input) : k === 'cnpj' ? isValidCNPJ(input) : false;
}

/** Máscara de exibição: 000.000.000-00 (CPF) ou 00.000.000/0000-00 (CNPJ). */
export function maskCpfCnpj(input: string): string {
  const d = onlyDigits(input).slice(0, 14);
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2');
  }
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2');
}

/**
 * O documento da CASA numa tela de LEITURA — recibo, aviso, rodapé.
 *
 * O comprovante e o aviso de privacidade imprimiam `65087663000130`: catorze
 * dígitos crus, num papel que a pessoa pode guardar. A landing mostrava o mesmo
 * documento formatado, e só porque alguém tinha digitado os pontos à mão no
 * JSX. Achado testando a plataforma no navegador, 2026-09-13.
 *
 * Mora AQUI, colado no `maskCpfCnpj`, e não num módulo novo: a primeira versão
 * disto reimplementou a formatação do zero, que é a forma "cópia divergente"
 * que este repositório passou a semana encontrando. Quem sabe pontuar continua
 * sendo um só; o que se acrescenta é a POLÍTICA de exibição.
 *
 * E a política é conservadora de propósito. O `maskCpfCnpj` é PROGRESSIVO —
 * formata entrada incompleta enquanto alguém digita, o que é certo num campo e
 * errado num recibo, onde `65.087.663/0001` (doze dígitos) pareceria um
 * documento de verdade. Aqui só passa o que está COMPLETO; o resto volta como
 * veio. A migração 0002 já tinha decidido o princípio: documento de mentira num
 * recibo de verdade é pior que a ausência dele.
 */
export function formatTaxId(raw: string | null | undefined, market?: string): string {
  if (!raw) return '';
  const limpo = String(raw).trim();
  // Na Espanha o NIF é `B12345678` — letra e oito dígitos, sem pontuação.
  // Pontuá-lo seria inventar um formato que o país não usa. Quem decide é o
  // MERCADO da casa, não a língua de quem lê — mesma regra do dinheiro.
  if (market === 'es') return limpo.toUpperCase();
  const digitos = onlyDigits(limpo);
  if (digitos.length === 11 || digitos.length === 14) return maskCpfCnpj(digitos);
  return limpo;
}

/** email suficiente pro Pagar.me (que exige e-mail no recebedor). */
export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

/**
 * Bancos brasileiros mais comuns (código de compensação de 3 dígitos). Lista
 * curada pros restaurantes — os grandes + fintechs + adquirentes. O form deixa
 * digitar um código fora da lista também (banco regional).
 */
export const BR_BANKS: { code: string; name: string }[] = [
  { code: '001', name: 'Banco do Brasil' },
  { code: '033', name: 'Santander' },
  { code: '104', name: 'Caixa Econômica Federal' },
  { code: '237', name: 'Bradesco' },
  { code: '341', name: 'Itaú' },
  { code: '260', name: 'Nubank' },
  { code: '077', name: 'Banco Inter' },
  { code: '336', name: 'C6 Bank' },
  { code: '208', name: 'BTG Pactual' },
  { code: '212', name: 'Banco Original' },
  { code: '290', name: 'PagBank (PagSeguro)' },
  { code: '323', name: 'Mercado Pago' },
  { code: '380', name: 'PicPay' },
  { code: '197', name: 'Stone' },
  { code: '655', name: 'Neon / Votorantim' },
  { code: '748', name: 'Sicredi' },
  { code: '756', name: 'Sicoob' },
  { code: '041', name: 'Banrisul' },
  { code: '070', name: 'BRB' },
  { code: '085', name: 'Ailos' },
  { code: '136', name: 'Unicred' },
  { code: '422', name: 'Banco Safra' },
  { code: '021', name: 'Banestes' },
  { code: '004', name: 'Banco do Nordeste' },
  { code: '218', name: 'Banco BS2' },
  { code: '121', name: 'Agibank' },
  { code: '246', name: 'Banco ABC Brasil' },
];

const BANK_BY_CODE = new Map(BR_BANKS.map((b) => [b.code, b.name]));

/** Nome do banco pelo código (3 dígitos), ou null se desconhecido. */
export function bankName(code: string): string | null {
  return BANK_BY_CODE.get(onlyDigits(code).padStart(3, '0')) ?? null;
}
