import { useCallback, useEffect, useState } from 'react';
import { authedReq as req } from './auth';
import { type ApiError } from './api';
import { useT } from './lang';
import { onlyDigits, alnum, isValidCNPJ, docKind, maskCpfCnpj, isValidEmail, BR_BANKS, bankName, normalizarDocumento } from './br';

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

export default function AdminRecipient({ venueId, onChanged }: { venueId: string; onChanged?: () => void }) {
  const { t, tErr } = useT();
  const [info, setInfo] = useState<RecipientInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // O recebedor cadastrado NÃO EXISTE MAIS no adquirente (um 404 de verdade): a
  // criação que vier daqui é SUBSTITUIÇÃO explícita (`replace: true`).
  const [substituir, setSubstituir] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [created, setCreated] = useState<CreatedRecipient | null>(null);
  const [idCopied, setIdCopied] = useState(false);

  // Formulário — strings cruas; documento e campos bancários mascarados no onChange.
  const [name, setName] = useState('');
  const [doc, setDoc] = useState('');
  const [email, setEmail] = useState('');
  const [notifyWhatsapp, setNotifyWhatsapp] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [agencia, setAgencia] = useState('');
  const [agenciaDv, setAgenciaDv] = useState('');
  const [conta, setConta] = useState('');
  const [contaDv, setContaDv] = useState('');
  const [accountType, setAccountType] = useState<'checking' | 'savings'>('checking');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Erro só aparece depois que o campo foi tocado (onBlur) ou numa tentativa de
  // enviar — não gritar em vermelho enquanto a pessoa ainda está digitando.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [triedSubmit, setTriedSubmit] = useState(false);
  // Banco: dropdown da lista curada, ou 'outro' → digita o código de compensação.
  const [bankOther, setBankOther] = useState(false);
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));
  const showErr = (k: string) => Boolean(touched[k]) || triedSubmit;

  const refresh = useCallback(async () => {
    try {
      const d = await req<RecipientInfo>(`/api/psp/recipient?v=${encodeURIComponent(venueId)}`);
      setInfo(d);
      setLoadError(null);
    } catch (e) {
      // Recebedor cadastrado mas inexistente no PSP atual (ex.: id de TESTE com o
      // app já em live → "Recipient not found") NÃO pode travar o painel: cai num
      // sentinel sem id pra o formulário aparecer e o dono criar um novo (que
      // sobrescreve o id morto). O aviso explica o porquê logo abaixo.
      // `tErr`, não `.message`: o servidor manda CÓDIGO e quem escolhe a
      // língua é o cliente. Esta tela era um dos chamadores esquecidos da
      // conversão que o `lang.tsx` descreve — e as duas chaves novas
      // (`tax_id_invalid`, `recipient_doc_mismatch`) chegavam aqui como
      // "HTTP 400", porque o 4xx vem só com `code` e o `api.ts` cai no
      // status quando não há `error`. Dicionário preenchido, frase nunca
      // exibida. Achado pela revisão de segurança de 2026-09-13.
      setLoadError(tErr(e));
      // SÓ o "recebedor não existe" abre o formulário de criar outro — e aí a
      // criação vai como substituição explícita. Uma falha passageira do
      // adquirente (rede, 5xx) mostrava "crie um novo; ele substitui o antigo"
      // e o formulário: um envio trocava pra onde o dinheiro da casa liquida
      // (auditoria de onboarding, C3). Agora ela só mostra o erro.
      if ((e as ApiError).code === 'recipient_not_found') {
        setSubstituir(true);
        setInfo((prev) => prev ?? { recipientId: null, status: null });
      }
    }
  }, [venueId, tErr]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (!info) {
    return (
      <section className="panel" id="recebimento">
        <p className="label">{t('rcpt.section')}</p>
        <p className="muted small">{loadError ?? t('admin.loading')}</p>
      </section>
    );
  }

  // 'rcpt_demo' e afins (venues antigos) não são recebedores de verdade.
  const realId = info.recipientId && /^r[ep]_/.test(info.recipientId) ? info.recipientId : null;
  const formVisible = !realId || showForm;

  // Validação por campo — a primeira barreira (o Pagar.me confere de novo na
  // criação, mas aqui pega o typo na hora, antes de gastar a chamada).
  const kind = docKind(doc); // 'cpf' | 'cnpj' | null (tamanho ainda incompleto)
  const valid = {
    name: name.trim().length >= 2,
    // CPF/CNPJ com dígito verificador — pega quase todo erro de digitação.
    // CNPJ, não "CPF ou CNPJ": o servidor recusa CPF desde 2026-09-13
    // (documento de casa é documento de empresa), e o formulário dizia
    // "CPF válido ✓" em verde, liberava o botão, e o dono levava
    // "Confira o número do documento" — o produto afirmando que o número
    // está certo e mandando conferir o número, sem caminho adiante e sem
    // dizer a regra. Cliente MAIS FROUXO que o servidor é sempre um beco.
    doc: isValidCNPJ(doc),
    // E-mail é OBRIGATÓRIO no Pagar.me (POST /recipients recusa sem ele).
    email: isValidEmail(email),
    bank: bankCode.length === 3,
    agencia: agencia.length >= 1,
    conta: conta.length >= 1,
    contaDv: contaDv.length >= 1,
  };
  const canSubmit = valid.name && valid.doc && valid.email && valid.bank && valid.agencia && valid.conta && valid.contaDv;
  const knownBank = bankName(bankCode); // nome do banco pelo código, ou null
  const marketplaceHint = submitError && /split|marketplace/i.test(submitError)
    ? t('rcpt.marketplaceHint')
    : null;

  // Borda vermelha só quando o campo foi tocado e está inválido.
  const errStyle = (key: string, ok: boolean) =>
    (showErr(key) && !ok ? { borderColor: 'var(--burgundy)' } : undefined);
  // Feedback abaixo do input: erro (vermelho) > confirmação (verde) > dica (cinza).
  const fb = (key: string, ok: boolean, errMsg: string, hint: string, okMsg?: string) => {
    if (showErr(key) && !ok) return <span className="small" style={{ display: 'block', marginTop: 4, color: 'var(--burgundy)' }}>{errMsg}</span>;
    if (ok && okMsg) return <span className="small" style={{ display: 'block', marginTop: 4, color: 'var(--emerald)' }}>{okMsg}</span>;
    return <span className="muted small" style={{ display: 'block', marginTop: 4 }}>{hint}</span>;
  };
  // UM CPF BEM FORMADO não é "dígito verificador errado" — os dígitos batem.
  // Dizer isso era o produto afirmando uma falsidade sobre o número da pessoa
  // e mandando conferir o que está certo, sem caminho adiante: o `fb` acima
  // troca a DICA pelo ERRO quando o campo está tocado e inválido, então a
  // única frase que explicava a regra sumia exatamente no estado que precisa
  // dela. Achado pelas duas revisões de 2026-09-13.
  const docErr = kind === 'cpf'
    ? t('rcpt.docCpfNo')
    : kind === null
      ? t('rcpt.docIncomplete')
      : t('rcpt.docDvBad');

  async function copyId() {
    if (!realId) return;
    await navigator.clipboard.writeText(realId).catch(() => {});
    setIdCopied(true);
  }

  async function submit() {
    setTriedSubmit(true);
    if (!canSubmit) {
      setSubmitError(t('rcpt.fixFields'));
      return;
    }
    setBusy(true); setSubmitError(null); setCreated(null);
    try {
      const r = await req<CreatedRecipient>('/api/psp/recipient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          // Trocar um recebedor de verdade é EXPLÍCITO: o servidor recusa sem
          // isto (409 `recipient_exists`).
          ...(substituir || realId ? { replace: true } : {}),
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {}),
          ...(notifyWhatsapp.trim() ? { notifyWhatsapp: notifyWhatsapp.trim() } : {}),
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
      setSubmitError(tErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" id="recebimento" style={{ scrollMarginTop: 16 }}>
      <p className="label">Recebimento</p>

      {!realId && (
        <div style={{ border: '1px solid rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', borderRadius: 12, padding: '10px 12px' }}>
          {loadError
            ? <p className="small">{t('rcpt.notFound')}</p>
            : <p className="small">{t('rcpt.none')}</p>}
          {info.recipientId && (
            <p className="muted small">O id atual ({info.recipientId}) é de demonstração — não recebe de verdade.</p>
          )}
        </div>
      )}

      {realId && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {info.status === 'active'
              ? <span className="pill paga">{t('rcpt.active', { id: shortId(realId) })}</span>
              : info.status === 'registration'
                ? <span className="pill parcial">{t('rcpt.review', { id: shortId(realId) })}</span>
                : <span className="pill aberta">{t('rcpt.statusOther', { id: shortId(realId), status: info.status ?? t('rcpt.unknown') })}</span>}
            <button className="ghost" style={{ padding: '6px 12px' }} onClick={copyId}>
              {idCopied ? t('rcpt.idCopied') : t('rcpt.copyId')}
            </button>
          </div>
          {info.status === 'registration' && (
            <p className="muted small">{t('rcpt.kycWait')}</p>
          )}
          {info.name && <p className="muted small">{t('rcpt.holder', { name: info.name })}</p>}
        </div>
      )}

      {loadError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{loadError}</p>}
      {created && (
        <p className="small" style={{ color: 'var(--emerald)' }}>
          {t('rcpt.created', { id: created.recipientId, status: created.status })}
        </p>
      )}

      {!formVisible && (
        <button className="linklike" style={{ alignSelf: 'flex-start' }} onClick={() => setShowForm(true)}>
          {t('rcpt.recreate')}
        </button>
      )}

      {formVisible && (
        <>
          <p className="muted small" style={{ marginTop: 4 }}>
            {t('rcpt.intro')}
          </p>

          <div className="cfggrid">
            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.holderLabel')}
              <input className="namefield" placeholder={t('rcpt.holderPh')} value={name}
                onBlur={() => touch('name')} style={errStyle('name', valid.name)}
                onChange={(e) => setName(e.target.value)} />
              {fb('name', valid.name, t('rcpt.holderNeed'), t('rcpt.holderHint'))}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.docLabel')}
              <input className="namefield" inputMode="text" autoCapitalize="characters" autoComplete="off"
                placeholder="00.000.000/0000-00" value={maskCpfCnpj(doc)}
                onBlur={() => touch('doc')} style={errStyle('doc', valid.doc)}
                onChange={(e) => setDoc(normalizarDocumento(e.target.value))} />
              {fb('doc', valid.doc, docErr, t('rcpt.docHint'),
                t('admin.cnpjOk'))}
              {/* A casa HERDA este documento quando ainda não tem um, e é ele
                  que o cliente lê no comprovante. Herança silenciosa num campo
                  que vai pra tela de terceiro é coisa que se descobre em
                  revisão; dizer custa uma linha. */}
              <span className="small" style={{ color: 'var(--ink-3)' }}>{t('rcpt.docOnReceipt')}</span>
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.emailLabel')}
              <input className="namefield" type="email" inputMode="email" placeholder={t('rcpt.emailPh')} value={email}
                onBlur={() => touch('email')} style={errStyle('email', valid.email)}
                onChange={(e) => setEmail(e.target.value)} />
              {fb('email', valid.email, t('rcpt.emailBad'), t('rcpt.emailHint'))}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.waLabel')} <span className="muted small">— {t('common.optional')}</span>
              <input className="namefield" inputMode="tel" placeholder="(11) 99999-9999" value={notifyWhatsapp}
                onChange={(e) => setNotifyWhatsapp(e.target.value)} />
              <span className="muted small" style={{ display: 'block', marginTop: 4 }}>{t('rcpt.waHint')}</span>
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.bankLabel')}
              <select className="namefield" value={bankOther ? '__other__' : bankCode}
                onBlur={() => touch('bank')} style={errStyle('bank', valid.bank)}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__other__') { setBankOther(true); setBankCode(''); }
                  else { setBankOther(false); setBankCode(val); }
                  touch('bank');
                }}>
                <option value="">{t('rcpt.pickBank')}</option>
                {BR_BANKS.map((b) => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
                <option value="__other__">{t('rcpt.otherBank')}</option>
              </select>
              {bankOther && (
                <input className="namefield" inputMode="numeric" placeholder={t('rcpt.bankCodePh')} value={bankCode}
                  style={{ marginTop: 8, ...(errStyle('bank', valid.bank) || {}) }}
                  onBlur={() => touch('bank')}
                  onChange={(e) => setBankCode(onlyDigits(e.target.value).slice(0, 3))} />
              )}
              {bankOther
                ? fb('bank', valid.bank, t('rcpt.bankCodeBad'),
                    knownBank ? t('rcpt.bankCodeKnown', { code: bankCode, bank: knownBank }) : t('rcpt.bankCodeHint'),
                    knownBank ? `${knownBank} ✓` : undefined)
                : fb('bank', valid.bank, t('rcpt.bankPickBad'), t('rcpt.bankHint'))}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              {t('rcpt.typeLabel')}
              <div style={{ display: 'flex', gap: 16, paddingTop: 8 }}>
                <label className="servico" style={{ alignItems: 'center' }}>
                  <input type="radio" name={`tipo-conta-${venueId}`} checked={accountType === 'checking'}
                    onChange={() => setAccountType('checking')} />
                  <span>{t('rcpt.checking')}</span>
                </label>
                <label className="servico" style={{ alignItems: 'center' }}>
                  <input type="radio" name={`tipo-conta-${venueId}`} checked={accountType === 'savings'}
                    onChange={() => setAccountType('savings')} />
                  <span>{t('rcpt.savings')}</span>
                </label>
              </div>
            </label>

            <label>
              {t('rcpt.branch')}
              <input className="namefield" inputMode="numeric" placeholder="0000" value={agencia}
                onBlur={() => touch('agencia')} style={errStyle('agencia', valid.agencia)}
                onChange={(e) => setAgencia(onlyDigits(e.target.value).slice(0, 5))} />
              {fb('agencia', valid.agencia, t('rcpt.branchNeed'), t('rcpt.branchHint'))}
            </label>
            <label>
              {t('rcpt.branchDv')}
              <input className="namefield" placeholder={t('rcpt.optionalPh')} value={agenciaDv}
                onChange={(e) => setAgenciaDv(alnum(e.target.value).slice(0, 2))} />
              <span className="muted small" style={{ display: 'block', marginTop: 4 }}>{t('rcpt.noBranchDv')}</span>
            </label>

            <label>
              {t('rcpt.account')}
              <input className="namefield" inputMode="numeric" placeholder="00000000" value={conta}
                onBlur={() => touch('conta')} style={errStyle('conta', valid.conta)}
                onChange={(e) => setConta(onlyDigits(e.target.value).slice(0, 13))} />
              {fb('conta', valid.conta, t('rcpt.accountNeed'), t('rcpt.accountHint'))}
            </label>
            <label>
              {t('rcpt.accountDv')}
              <input className="namefield" placeholder="0" value={contaDv}
                onBlur={() => touch('contaDv')} style={errStyle('contaDv', valid.contaDv)}
                onChange={(e) => setContaDv(alnum(e.target.value).slice(0, 2))} />
              {fb('contaDv', valid.contaDv, t('rcpt.accountDvNeed'), t('rcpt.accountDvHint'))}
            </label>
          </div>

          <p className="muted small">{t('rcpt.sameDoc')}</p>

          {submitError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{submitError}</p>}
          {marketplaceHint && <p className="muted small">{marketplaceHint}</p>}

          <button className="cta" style={{ padding: '12px 20px' }} disabled={busy} onClick={submit}>
            {busy ? t('rcpt.sending') : t('rcpt.create')}
          </button>
          {realId && (
            <button className="linklike" onClick={() => { setShowForm(false); setSubmitError(null); }}>
              {t('rcpt.cancel')}
            </button>
          )}
        </>
      )}
    </section>
  );
}
