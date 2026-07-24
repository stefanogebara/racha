/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Chave PUBLICÁVEL do Pagar.me (pk_test_/pk_live_) — browser-safe por design. */
  readonly VITE_PAGARME_PUBLIC_KEY?: string;
  /** Account id (acc_...) — gatewayMerchantId do Google Pay (guia Pagar.me). */
  readonly VITE_PAGARME_ACCOUNT_ID?: string;
  /** Chave PUBLICÁVEL do Stripe (pk_test_/pk_live_) — 2º rail (cartão/Apple Pay).
   *  Browser-safe. Sem ela, o Express Checkout Element não aparece. */
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string;
  /** merchantId do Google (BCR2DN...) do Google Pay & Wallet Console —
   *  OBRIGATÓRIO no environment PRODUCTION (dispensável em TEST). NÃO é o
   *  acc_ do Pagar.me. Só setar no go-live, depois de verificar o domínio. */
  readonly VITE_GOOGLE_PAY_MERCHANT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
