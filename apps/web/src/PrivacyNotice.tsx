import { useState } from 'react';
import { useT } from './lang';
import { formatTaxId } from './br';

/**
 * O aviso do art. 9º, na tela da conta.
 *
 * Lacuna 2 do `docs/compliance/data-map.md`, e a que bloqueia o primeiro QR
 * numa mesa de cliente de verdade. A tela onde a pessoa digita o nome e paga
 * não dizia quem trata o dado, pra quê, pra quem vai, nem por quanto tempo.
 *
 * Fica no RODAPÉ da conta, aberto por toque, e não numa página separada: o art.
 * 9º pede informação acessível ANTES da decisão, e um link que leva pra fora da
 * tela de pagar é um link que ninguém toca no meio de um jantar. Fechado por
 * padrão porque a alternativa — um bloco de texto legal entre a conta e o botão
 * de pagar — é o jeito de fazer com que não seja lido.
 *
 * Cada frase daqui aponta pra uma defesa que existe no código, não pra uma
 * intenção: o cartão não passa pelos nossos servidores (`/pure` + campos do
 * PSP), o CPF é repassado e não persistido (`create-charge.js`), o nome some em
 * 90 dias (`purge_expired_personal_data`, migração 0031). É por isso que o
 * texto foi escrito DEPOIS do `docs/compliance/retencao.md`.
 */
/**
 * O canal direto, vindo de FORA — e ausente quando não existe.
 *
 * A primeira versão trazia `privacidade@racha.com.br` escrito na linha. Eu
 * inventei esse endereço: o `dig` devolve `MX 0 .`, o MX nulo da RFC 7505, que
 * é o domínio declarando que NÃO recebe e-mail. Um cliente que escrevesse pra
 * lá levava bounce — e o canal que o `retencao.md` tinha acabado de chamar de
 * "a condição que faltava" faltava outra vez.
 *
 * Caixa que não existe é pior do que não prometer caixa nenhuma: o restaurante
 * é o controlador do dado do pagamento e é uma rota de verdade. Então sem
 * `VITE_PRIVACY_CONTACT` a frase do canal direto some, em vez de mentir.
 */
const CONTATO = (import.meta.env.VITE_PRIVACY_CONTACT as string | undefined)?.trim() || '';

/**
 * Os prazos que o aviso promete, num lugar só.
 *
 * Havia nove "90" escritos à mão no bloco `priv.*`, e o teste que amarra
 * promessa↔job só via os três do `priv.what1` — inclusive a camada 1, que é a
 * única linha que TODO cliente lê, ficava de fora. Agora o número entra por
 * interpolação e o censo confere este arquivo contra o padrão da função SQL.
 */
export const RETENCAO_DIAS = { rotulo: 90, carteira: 90 };

export default function PrivacyNotice(
  { venue, taxId, market }: { venue: string; taxId?: string | null; market?: string },
) {
  const { t } = useT();
  const [aberto, setAberto] = useState(false);
  // Sem documento da casa a frase não pode ficar com um parêntese vazio.
  // Sem documento da casa, a frase sai SEM o parêntese — `Casa (—)` parece bug,
  // e um aviso que parece quebrado não informa ninguém.
  const quem = taxId
    ? t('priv.who', { venue, taxId: formatTaxId(taxId, market) })
    // Sem `taxId` o `fill` deixa `{taxId}` literal; o parêntese sai inteiro.
    : t('priv.who', { venue }).replace(/\s*\(\{taxId\}\)/, '');

  return (
    <>
      {/* CAMADA 1, sempre visível. Um controle que só diz "seus dados" é um
          rótulo: quem não abrir não recebe informação nenhuma, e o art. 9º pede
          informação ANTES da decisão. Esta linha responde quem, o quê e por
          quanto tempo sem exigir um toque. */}
      <span className="muted small">{t('priv.teaser', { venue, days: RETENCAO_DIAS.rotulo })}</span>
      <button
        type="button"
        className="linklike small"
        aria-expanded={aberto}
        onClick={() => setAberto((v) => !v)}
      >
        {t('priv.link')}
      </button>
      {aberto && (
        <section className="card privacy" style={{ textAlign: 'left', marginTop: 8 }}>
          <p className="label">{t('priv.title')}</p>
          <p className="muted small">{quem}</p>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.whatTitle')}</p>
          <ul className="muted small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>{t('priv.what1', { days: RETENCAO_DIAS.rotulo })}</li>
            <li>{t('priv.what2')}</li>
            <li>{t('priv.what3', { days: RETENCAO_DIAS.carteira })}</li>
          </ul>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.noTitle')}</p>
          <ul className="muted small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>{t('priv.no1')}</li>
            <li>{t('priv.no2')}</li>
            <li>{t('priv.no3')}</li>
          </ul>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.whoElseTitle')}</p>
          <p className="muted small">{t('priv.whoElse')}</p>
          <p className="muted small" style={{ marginTop: 10 }}>
            {CONTATO
              ? t('priv.rights', { venue, email: CONTATO })
              : t('priv.rightsNoEmail', { venue })}
          </p>

          <button type="button" className="linklike small" onClick={() => setAberto(false)}>
            {t('priv.close')}
          </button>
        </section>
      )}
    </>
  );
}
