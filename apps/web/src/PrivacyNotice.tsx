import { useState } from 'react';
import { useT } from './lang';

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
export default function PrivacyNotice() {
  const { t } = useT();
  const [aberto, setAberto] = useState(false);

  return (
    <>
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
          <p className="muted small">{t('priv.who')}</p>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.whatTitle')}</p>
          <ul className="muted small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>{t('priv.what1')}</li>
            <li>{t('priv.what2')}</li>
          </ul>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.noTitle')}</p>
          <ul className="muted small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            <li>{t('priv.no1')}</li>
            <li>{t('priv.no2')}</li>
            <li>{t('priv.no3')}</li>
          </ul>

          <p className="label small" style={{ marginTop: 10 }}>{t('priv.whoElseTitle')}</p>
          <p className="muted small">{t('priv.whoElse')}</p>
          <p className="muted small" style={{ marginTop: 10 }}>{t('priv.rights')}</p>

          <button type="button" className="linklike small" onClick={() => setAberto(false)}>
            {t('priv.close')}
          </button>
        </section>
      )}
    </>
  );
}
