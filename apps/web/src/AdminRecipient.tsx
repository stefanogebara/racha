import { useCallback, useEffect, useState } from 'react';
import { authedReq as req } from './auth';
import { onlyDigits, alnum, isValidCpfCnpj, docKind, maskCpfCnpj, isValidEmail, BR_BANKS, bankName } from './br';

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
  const [info, setInfo] = useState<RecipientInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      setLoadError((e as Error).message);
      setInfo((prev) => prev ?? { recipientId: null, status: null });
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

  // Validação por campo — a primeira barreira (o Pagar.me confere de novo na
  // criação, mas aqui pega o typo na hora, antes de gastar a chamada).
  const kind = docKind(doc); // 'cpf' | 'cnpj' | null (tamanho ainda incompleto)
  const valid = {
    name: name.trim().length >= 2,
    // CPF/CNPJ com dígito verificador — pega quase todo erro de digitação.
    doc: isValidCpfCnpj(doc),
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
    ? 'A conta Pagar.me ainda não está em modo marketplace — o comercial precisa habilitar (pedido já feito).'
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
  const docErr = kind === null
    ? 'CPF tem 11 dígitos, CNPJ tem 14 — ainda faltam números.'
    : 'Os dígitos verificadores não batem — confira o número.';

  async function copyId() {
    if (!realId) return;
    await navigator.clipboard.writeText(realId).catch(() => {});
    setIdCopied(true);
  }

  async function submit() {
    setTriedSubmit(true);
    if (!canSubmit) {
      setSubmitError('Confira os campos destacados em vermelho antes de continuar.');
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
      setSubmitError((e as Error).message);
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
            ? <p className="small">⚠ O recebedor cadastrado não foi encontrado no Pagar.me deste ambiente — provavelmente foi criado em teste e o app já está em live. Crie um novo abaixo; ele substitui o antigo.</p>
            : <p className="small">⚠ Sem recebedor configurado — cobranças reais não liquidam até criar.</p>}
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
          <p className="muted small" style={{ marginTop: 4 }}>
            São os dados bancários do restaurante — é pra onde o dinheiro das comandas cai.
            Precisam ser <strong>exatamente</strong> os dados da conta no banco; o Pagar.me
            confere com a Receita e recusa se não bater.
          </p>

          <div className="cfggrid">
            <label style={{ gridColumn: '1 / -1' }}>
              Razão social / nome do titular
              <input className="namefield" placeholder="Como está no cadastro do banco" value={name}
                onBlur={() => touch('name')} style={errStyle('name', valid.name)}
                onChange={(e) => setName(e.target.value)} />
              {fb('name', valid.name, 'Informe o nome do titular da conta.', 'Igual ao cadastro no banco / na Receita.')}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              CNPJ ou CPF do titular
              <input className="namefield" inputMode="numeric" placeholder="00.000.000/0000-00" value={maskCpfCnpj(doc)}
                onBlur={() => touch('doc')} style={errStyle('doc', valid.doc)}
                onChange={(e) => setDoc(onlyDigits(e.target.value).slice(0, 14))} />
              {fb('doc', valid.doc, docErr, 'CNPJ do restaurante (14 díg.) ou seu CPF (11 díg.).',
                kind === 'cpf' ? 'CPF válido ✓' : 'CNPJ válido ✓')}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              E-mail do restaurante
              <input className="namefield" type="email" inputMode="email" placeholder="contato@restaurante.com.br" value={email}
                onBlur={() => touch('email')} style={errStyle('email', valid.email)}
                onChange={(e) => setEmail(e.target.value)} />
              {fb('email', valid.email, 'E-mail inválido — confira o formato.', 'O Pagar.me exige — usa pra avisar sobre os repasses.')}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              WhatsApp do dono (avisos) <span className="muted small">— opcional</span>
              <input className="namefield" inputMode="tel" placeholder="(11) 99999-9999" value={notifyWhatsapp}
                onChange={(e) => setNotifyWhatsapp(e.target.value)} />
              <span className="muted small" style={{ display: 'block', marginTop: 4 }}>Pra te avisar por WhatsApp quando o KYC aprovar (ou recusar). Sem isso, só por e-mail.</span>
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
              Banco
              <select className="namefield" value={bankOther ? '__other__' : bankCode}
                onBlur={() => touch('bank')} style={errStyle('bank', valid.bank)}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === '__other__') { setBankOther(true); setBankCode(''); }
                  else { setBankOther(false); setBankCode(val); }
                  touch('bank');
                }}>
                <option value="">Selecione o banco…</option>
                {BR_BANKS.map((b) => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
                <option value="__other__">Outro banco (digitar código)…</option>
              </select>
              {bankOther && (
                <input className="namefield" inputMode="numeric" placeholder="Código de compensação (3 dígitos, ex.: 218)" value={bankCode}
                  style={{ marginTop: 8, ...(errStyle('bank', valid.bank) || {}) }}
                  onBlur={() => touch('bank')}
                  onChange={(e) => setBankCode(onlyDigits(e.target.value).slice(0, 3))} />
              )}
              {bankOther
                ? fb('bank', valid.bank, 'O código de compensação tem 3 dígitos.',
                    knownBank ? `Código ${bankCode} — ${knownBank}.` : 'Código de compensação do banco (3 dígitos).',
                    knownBank ? `${knownBank} ✓` : undefined)
                : fb('bank', valid.bank, 'Escolha o banco da conta.', 'Onde a conta do restaurante está.')}
            </label>

            <label style={{ gridColumn: '1 / -1' }}>
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
              <input className="namefield" inputMode="numeric" placeholder="0000" value={agencia}
                onBlur={() => touch('agencia')} style={errStyle('agencia', valid.agencia)}
                onChange={(e) => setAgencia(onlyDigits(e.target.value).slice(0, 5))} />
              {fb('agencia', valid.agencia, 'Informe a agência.', 'Sem o dígito — ele vai no campo ao lado.')}
            </label>
            <label>
              Dígito da agência
              <input className="namefield" placeholder="opcional" value={agenciaDv}
                onChange={(e) => setAgenciaDv(alnum(e.target.value).slice(0, 2))} />
              <span className="muted small" style={{ display: 'block', marginTop: 4 }}>Deixe vazio se a agência não tem dígito.</span>
            </label>

            <label>
              Conta
              <input className="namefield" inputMode="numeric" placeholder="00000000" value={conta}
                onBlur={() => touch('conta')} style={errStyle('conta', valid.conta)}
                onChange={(e) => setConta(onlyDigits(e.target.value).slice(0, 13))} />
              {fb('conta', valid.conta, 'Informe o número da conta.', 'Número da conta, sem o dígito.')}
            </label>
            <label>
              Dígito da conta
              <input className="namefield" placeholder="0" value={contaDv}
                onBlur={() => touch('contaDv')} style={errStyle('contaDv', valid.contaDv)}
                onChange={(e) => setContaDv(alnum(e.target.value).slice(0, 2))} />
              {fb('contaDv', valid.contaDv, 'Informe o dígito da conta.', 'Geralmente 1 caractere (pode ser X).')}
            </label>
          </div>

          <p className="muted small">A conta precisa pertencer ao mesmo CNPJ/CPF do documento — é a regra do KYC do Pagar.me.</p>

          {submitError && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{submitError}</p>}
          {marketplaceHint && <p className="muted small">{marketplaceHint}</p>}

          <button className="cta" style={{ padding: '12px 20px' }} disabled={busy} onClick={submit}>
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
