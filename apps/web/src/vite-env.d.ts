/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Chave PUBLICÁVEL do Pagar.me (pk_test_/pk_live_) — browser-safe por design. */
  readonly VITE_PAGARME_PUBLIC_KEY?: string;
  /** Account id (acc_...) — gatewayMerchantId do Google Pay (guia Pagar.me). */
  readonly VITE_PAGARME_ACCOUNT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
