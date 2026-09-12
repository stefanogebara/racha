// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * O lint existe por UMA regra, e as outras vieram junto.
 *
 * `react-hooks/exhaustive-deps` teria pego, sem ninguém olhar, três closures
 * velhas encontradas à mão em 2026-09-10 — `rotate`, `toggle` e
 * `closeManualCheck` chamavam `tr(...)` com `[refresh]` na lista de
 * dependências, então o diálogo que o dono lê antes de uma ação IRREVERSÍVEL
 * (girar QR, desativar mesa, fechar conta) ficava no idioma anterior depois de
 * trocar de língua. Duas delas foram consertadas no commit que introduziu a
 * terceira. É exatamente o tipo de erro que humano não vê e ferramenta vê
 * sempre.
 *
 * `no-floating-promises` entra pelo mesmo motivo do outro lado: neste
 * repositório quase toda promessa solta é dinheiro (`registerCharge`,
 * `refresh`), e uma rejeição não tratada num handler de pagamento é um erro que
 * some.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'public/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { window: 'readonly', document: 'readonly', console: 'readonly',
                 sessionStorage: 'readonly', localStorage: 'readonly', crypto: 'readonly',
                 fetch: 'readonly', navigator: 'readonly', setTimeout: 'readonly',
                 clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
                 URLSearchParams: 'readonly', URL: 'readonly', Response: 'readonly',
                 HTMLElement: 'readonly', RequestInit: 'readonly' },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A regra pela qual isto existe. ERRO, não aviso: um aviso que ninguém lê
      // é a mesma coisa que não ter a regra.
      'react-hooks/exhaustive-deps': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      // O resto do `recommendedTypeChecked` é útil mas ruidoso num código que
      // já passa no `tsc` estrito; fica como aviso pra não afogar as duas de
      // cima. A promoção de cada uma é uma decisão, não um padrão.
      '@typescript-eslint/no-explicit-any': 'warn',
      // DESLIGADA de propósito, com o motivo escrito. Ela reclama de
      // `onClick={async () => …}`, que é a forma idiomática de um handler que
      // chama a API em React — 47 ocorrências, todas com `try/catch` dentro.
      // Ligar isso obrigaria a envolver cada handler num wrapper `void`, o que
      // é ruído mecânico sem ganho de segurança, e ruído é o que faz alguém
      // desligar o lint inteiro.
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
);
