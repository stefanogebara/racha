import { useLayoutEffect, useRef } from 'react';
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from 'react';
import { caretDepoisDaMascara } from './mascara-caret';

/**
 * UM CAMPO COM RÓTULO VISÍVEL — a moldura do Presence (`.ps-field-row label`).
 *
 * Todo campo desta plataforma era placeholder e mais nada. O rótulo sumia no
 * primeiro caractere, e num formulário de "CNPJ / agência / conta / CPF do
 * responsável" quem volta pra conferir não sabe mais em qual campo está. O
 * `aria-label` que existia resolvia pro leitor de tela e não pra quem enxerga.
 *
 * O componente carrega junto as três coisas que faltavam em todo call site:
 *  · `<label>` DE VERDADE (o `htmlFor` implícito, porque o input é filho) —
 *    então tocar no rótulo foca o campo, que num telefone é metade do alvo;
 *  · `autoComplete`, que é o que faz o teclado do telefone oferecer o valor
 *    que a pessoa já tem guardado — num fluxo de pagamento, cada campo digitado
 *    à mão é uma chance de desistir;
 *  · `aria-invalid` + o recado colado no campo, em vez de uma frase solta no
 *    fim do formulário.
 *
 * A cor NUNCA é a mensagem: `ruim` pinta a moldura E o rótulo, e quem usa o
 * componente escreve o `recado` (WCAG 1.4.1).
 */
export type CampoProps = {
  rotulo: string;
  /** O recado colado no campo — o porquê da recusa, ou uma dica. */
  recado?: ReactNode;
  /** `ruim` quando o valor não serve; só aí a moldura vai pra coral. */
  ruim?: boolean;
  /** `bom` pinta o recado de musgo (um "confere" curto), nunca a moldura. */
  bom?: boolean;
  /**
   * CAMPO MASCARADO. Quando isto existe, o `Campo` assume o cursor.
   *
   * Um `<input>` controlado cujo valor é reescrito a cada tecla perde o cursor
   * pro fim do texto. Medido no navegador, com teclas de verdade, em
   * 2026-09-16: com `529.982.247-25` no campo do CPF e o cursor na posição 3,
   * um Backspace devolvia o valor certo e o cursor na posição **13** — o fim.
   * A tecla seguinte caía no lugar errado, e a seguinte também: não dava pra
   * corrigir um dígito do meio sem apagar tudo. Um campo que briga assim é
   * lido como "travou", e foi essa a pergunta que abriu esta investigação.
   *
   * O `value` que chega continua sendo o do chamador; quem formata pra tela é
   * este componente, e quem repõe o cursor também. Ver `mascara-caret.ts` — a
   * conta é pura e tem teste próprio.
   */
  mascara?: (bruto: string) => string;
} & InputHTMLAttributes<HTMLInputElement>;

export function Campo({ rotulo, recado, ruim, bom, mascara, value, onChange, ...resto }: CampoProps) {
  const ref = useRef<HTMLInputElement>(null);
  /** Onde o cursor deve parar depois que o React pintar o valor novo. */
  const caretPendente = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const pos = caretPendente.current;
    caretPendente.current = null;
    // Só mexe no cursor se ele for de QUEM ESTÁ DIGITANDO: repor a seleção num
    // campo sem foco rouba o foco e rola a página até ele.
    if (el && pos !== null && document.activeElement === el) {
      el.setSelectionRange(pos, pos);
    }
  });

  const aoMudar = mascara
    ? (e: ChangeEvent<HTMLInputElement>) => {
      // Lido AQUI, antes de o React repintar: depois da repintura o
      // `selectionStart` já é o do valor novo, que é justamente o fim.
      caretPendente.current = caretDepoisDaMascara(
        e.target.value,
        e.target.selectionStart ?? e.target.value.length,
        mascara(e.target.value),
      );
      onChange?.(e);
    }
    : onChange;

  return (
    <div>
      <label className={`campo${ruim ? ' ruim' : ''}`}>
        <span>{rotulo}</span>
        <input
          {...resto}
          ref={ref}
          value={mascara ? mascara(String(value ?? '')) : value}
          onChange={aoMudar}
          aria-invalid={ruim || undefined}
        />
      </label>
      {recado && <span className={`campo-msg${ruim ? ' ruim' : bom ? ' bom' : ''}`}>{recado}</span>}
    </div>
  );
}
