import { useLayoutEffect, useRef } from 'react';
import type { ChangeEvent } from 'react';
import { caretDepoisDaMascara } from './mascara-caret';

/**
 * O CURSOR DE UM CAMPO MASCARADO — pra quem não usa o `Campo`.
 *
 * A conta de onde o cursor tem que parar vive em `mascara-caret.ts`; quem a
 * aplica era só o `Campo`. O `AdminRecipient` monta os campos dele à mão (ele
 * tem a própria moldura de erro e de dica), então ficou de fora — e o cabeçalho
 * do `mascara-caret.ts` afirmava cobrir "o documento do recebedor", que era
 * justamente o que não estava coberto. A segunda revisão de segurança de
 * 2026-09-16 (LOW-D) apontou a afirmação, e uma afirmação de cobertura errada é
 * pior que nenhuma: é ela que faz ninguém olhar de novo.
 *
 * Então a aplicação vira um gancho, e os dois caminhos o importam.
 *
 * ```tsx
 * const cpf = useMascara(maskCpfCnpj, doc, (v) => setDoc(normalizarDocumento(v)));
 * <input {...cpf} />
 * ```
 */
export function useMascara(
  mascara: (bruto: string) => string,
  valor: string,
  aoMudarCru: (bruto: string) => void,
) {
  const ref = useRef<HTMLInputElement>(null);
  /** Onde o cursor deve parar depois que o React pintar o valor novo. */
  const caretPendente = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const pos = caretPendente.current;
    caretPendente.current = null;
    // Só mexe no cursor se ele for de QUEM ESTÁ DIGITANDO: repor a seleção num
    // campo sem foco rouba o foco e rola a página até ele.
    if (el && pos !== null && document.activeElement === el) el.setSelectionRange(pos, pos);
  });

  return {
    ref,
    value: mascara(valor),
    onChange(e: ChangeEvent<HTMLInputElement>) {
      // Lido AQUI, antes de o React repintar: depois da repintura o
      // `selectionStart` já é o do valor novo, que é justamente o fim.
      caretPendente.current = caretDepoisDaMascara(
        e.target.value,
        e.target.selectionStart ?? e.target.value.length,
        mascara(e.target.value),
      );
      aoMudarCru(e.target.value);
    },
  };
}
