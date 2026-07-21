import { useCallback, useEffect, useState } from 'react';
import { authedReq as req } from './auth';

/**
 * "Recebimento" — o recebedor Pagar.me (split) do restaurante, por venue.
 * Sem um rp_ ativo, cobranças reais não liquidam: o dinheiro pago pelos
 * clientes não tem para onde ir. O POST cria o recebedor e dispara a análise
 * KYC do gateway (registration → active, ~3 dias úteis); o GET reflete o
 * status atual. Erros 4xx chegam com a mensagem do gateway em PT e são
 * exibidos verbatim — ela é a única pista real do que o banco recusou.
 */

interface RecipientInfo {
  /** null = nunca configurado; valor sem 'rp_' (ex.: 'rcpt_demo') = venue antigo, não recebe de verdade. */
  recipientId: string | null;
  /** 'registration' (KYC em análise) | 'active' (pronto) | outros. */
  status: string | null;
  name?: string;
}

interface CreatedRecipient { recipientId: string; status: string }

/** rp_AbCd1234Ef56 → "rp_AbCd1234…" — o botão ao lado copia o id inteiro. */
const shortId = (id: string) => (id.length > 11 ? `${id.slice(0, 11)}…` : id);

const onlyDigits = (s: string) => s.replace(/\D/g, '');
/** Dígito verificador pode ser letra em alguns bancos (ex.: conta 'X' no BB). */
const alnum = (s: string) => s.replace(/[^0-9a-zA-Z]/g, '');

export default function AdminRecipient({ venueId, onChanged }: { venueId: string; onChanged?: () => void }) {
  const [info, setInfo] = useState<RecipientInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState<CreatedRecipient | null>(null);
  const [idCopied, setIdCopied] = useState(false);

  // Formulário — strings cruas; documento e campos bancários mascarados no onChange.
  const [name, setName] = useState('');
  const [doc, setDoc] = useState('');
  const [email, setEmail] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [agencia, setAgencia] = useState('');
  const [agenciaDv, setAgenciaDv] = useState('');
  const [conta, setConta] = useState('');
  const [contaDv, setContaDv] = useState('');
  const [accountType, setAccountType] = useState<'checking' | 'savings'>('checking');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const d = await req<RecipientInfo>(`/api/psp/recipient?v=${encodeURIComponent(venueId)}`);
      setInfo(d);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [venueId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!info) {
    return (
      <section className="panel" id="recebimento">
        <p className="label">Recebimento</p>
        <p className="muted small">{loadError ?? 'carregando…'}</p>
      </section>
    );
  }

  // 'rcpt_demo' e afins (venues antigos) não são recebedores de verdade.
  const realId = info.recipientId && /^r[ep]_/.test(info.recipientId) ? info.recipientId : null;
  const formVisible = !realId || showForm;
  const requiredMissing = !name.trim() || !doc || !bankCode || !agencia || !conta || !contaDv;
  const marketplaceHint = submitError && /split|marketplace/i.test(submitError)
    ? 'A conta Pagar.me ainda não está em modo marketplace — o comercial precisa habilitar (pedido já feito).'
    : null;

  async function copyId() {
    if (!realId) return;
    await navigator.clipboard.writeText(realId).catch(() => {});
    setIdCopied(true);
  }

  async function submit() {
    if (doc.length !== 11 && doc.length !== 14) {
      setSubmitError('CPF tem 11 dígitos e CNPJ tem 14 — confira o documento.');
      return;
    }
    if (bankCode.length !== 3) {
      setSubmitError('O código do banco tem 3 dígitos (ex.: 260, 341).');
      return;
    }
    setBusy(true); setSubmitError(null); setCreated(null);
    try {
      const r = await req<CreatedRecipient>('/api/psp/recipient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          document: doc,
          bank: {
            code: bankCode,
            agencia,
            ...(agenciaDv ? { agenciaDv } : {}),
            conta,
            contaDv,
            type: accountType,
          },
        }),
      });
      setCreated(r);
      setShowForm(false);
      setIdCopied(false);
      await refresh(); // reflete o status novo (registration/active)
      onChanged?.(); // o aviso âmbar do topo da página some sem F5
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="recebimento">
      <p className="label">Recebimento</p>

      {!realId && (
        <div style={{ border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', borderRadius: 12, padding: '10px 12px' }}>
          <p className="small">⚠ Sem recebedor configurado — cobranças reais não liquidam até criar.</p>
          {info.recipientId && (
            <p className="muted small">O id atual ({info.recipientId}) é de demonstração — não recebe de verdade.</p>
          )}
        </div>
      )}

      {realId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {info.status === 'active'
              ? <span className="pill paga">Recebedor ativo · {shortId(realId)}</span>
              : info.status === 'registration'
                ? <span className="pill parcial">Em análise · {shortId(realId)}</span>
                : <span className="pill aberta">{shortId(realId)} · status: {info.status ?? 'desconhecido'}</span>}
            <button className="ghost" style={{ padding: '6px 12px' }} onClick={copyId}>
              {idCopied ? 'id copiado ✓' : 'copiar id'}
            </button>
          </div>
          {info.status === 'registration' && (
            <p className="muted small">Em análise no Pagar.me (KYC) — normal levar ~3 dias úteis.</p>
          )}
          {info.name && <p className="muted small">Titular: {info.name}</p>}
        </div>
      )}

      {loadError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{loadError}</p>}
      {created && (
        <p className="small" style={{ color: 'var(--emerald)' }}>
          Recebedor {created.recipientId} criado ✓ — status: {created.status}
        </p>
      )}

      {!formVisible && (
        <button className="linklike" style={{ alignSelf: 'flex-start' }} onClick={() => setShowForm(true)}>
          recriar recebedor
        </button>
      )}

      {formVisible && (
        <>
          <div className="cfggrid">
            <label style={{ gridColumn: '1 / -1' }}>
              Razão social / nome
              <input className="namefield" placeholder="Como está no banco" value={name}
                onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              CNPJ ou CPF
              <input className="namefield" inputMode="numeric" placeholder="só números" value={doc}
                onChange={(e) => setDoc(onlyDigits(e.target.value).slice(0, 14))} />
            </label>
            <label>
              E-mail (opcional)
              <input className="namefield" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Banco (código)
              <input className="namefield" inputMode="numeric" placeholder="260 = Nubank, 341 = Itaú…" value={bankCode}
                onChange={(e) => setBankCode(onlyDigits(e.target.value).slice(0, 3))} />
            </label>
            <label>
              Tipo de conta
              <div style={{ display: 'flex', gap: 16, paddingTop: 8 }}>
                <label className="servico" style={{ alignItems: 'center' }}>
                  <input type="radio" name={`tipo-conta-${venueId}`} checked={accountType === 'checking'}
                    onChange={() => setAccountType('checking')} />
                  <span>Corrente</span>
                </label>
                <label className="servico" style={{ alignItems: 'center' }}>
                  <input type="radio" name={`tipo-conta-${venueId}`} checked={accountType === 'savings'}
                    onChange={() => setAccountType('savings')} />
                  <span>Poupança</span>
                </label>
              </div>
            </label>
            <label>
              Agência
              <input className="namefield" inputMode="numeric" value={agencia}
                onChange={(e) => setAgencia(onlyDigits(e.target.value).slice(0, 5))} />
            </label>
            <label>
              Dígito da agência (opcional)
              <input className="namefield" value={agenciaDv}
                onChange={(e) => setAgenciaDv(alnum(e.target.value).slice(0, 2))} />
            </label>
            <label>
              Conta
              <input className="namefield" inputMode="numeric" value={conta}
                onChange={(e) => setConta(onlyDigits(e.target.value).slice(0, 13))} />
            </label>
            <label>
              Dígito da conta
              <input className="namefield" value={contaDv}
                onChange={(e) => setContaDv(alnum(e.target.value).slice(0, 2))} />
            </label>
          </div>

          <p className="muted small">A conta precisa pertencer ao mesmo CNPJ/CPF do documento — é a regra do KYC.</p>

          {submitError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{submitError}</p>}
          {marketplaceHint && <p className="muted small">{marketplaceHint}</p>}

          <button className="cta" style={{ padding: '12px 20px' }} disabled={busy || requiredMissing} onClick={submit}>
            {busy ? 'enviando…' : 'Criar recebedor'}
          </button>
          {realId && (
            <button className="linklike" onClick={() => { setShowForm(false); setSubmitError(null); }}>
              cancelar
            </button>
          )}
        </>
      )}
    </section>
  );
}
