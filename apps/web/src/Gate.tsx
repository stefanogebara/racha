import { useEffect, useState, type ReactNode } from 'react';
import { useT, LangToggle } from './lang';
import { Campo } from './Campo';
import { isValidEmail } from './br';
import { onSession, signIn, signUp, signInWithGoogle, resetPassword, supabase, GOOGLE_LIGADO, SENHA_MINIMA, emRecuperacaoDeSenha, definirSenhaNova } from './auth';

/**
 * Owner login gate — wraps the restaurant surfaces (/admin, /painel). Diners
 * never see this: the conta flow is public. Until there's a session, renders
 * the login form; once logged in, renders children.
 */
export default function Gate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [recuperando, setRecuperando] = useState(false);

  useEffect(() => onSession((s) => { setAuthed(!!s); setRecuperando(!!s && emRecuperacaoDeSenha()); setReady(true); }), []);

  if (!supabase) {
    return <main className="shell"><section className="card"><p className="muted center">
      {t('gate.notConfigured')}
    </p></section></main>;
  }
  if (!ready) return <main className="shell"><p className="muted center">{t('admin.loading')}</p></main>;
  // Voltou do link de "esqueci a senha": a sessão existe, mas a senha nova vem
  // ANTES do painel (auditoria do portão, P3).
  if (authed && recuperando) return <SenhaNova onDone={() => setRecuperando(false)} />;
  return authed ? <>{children}</> : <Login onDone={() => setAuthed(true)} />;
}

function SenhaNova({ onDone }: { onDone: () => void }) {
  const { t, tErr } = useT();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valida = password.length >= SENHA_MINIMA;
  async function enviar() {
    if (!valida || busy) return;
    setBusy(true); setError(null);
    try { await definirSenhaNova(password); onDone(); }
    catch (e) { setError(tErr(e)); setBusy(false); }
  }
  return (
    <main className="shell">
      <header className="head">
        <span className="venue">Racha</span>
        <span className="mesa">{t('gate.ownerPanel')}</span>
      </header>
      <form className="card" onSubmit={(e) => { e.preventDefault(); void enviar(); }}>
        <h1 className="label">{t('gate.resetTitle')}</h1>
        <Campo rotulo={t('gate.newPassword')} type="password" autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
        <p className="muted small" id="regra-senha">{t('gate.passwordRule', { n: String(SENHA_MINIMA) })}</p>
        <p className="muted small" role="status" aria-live="polite" style={{ margin: 0 }}>
          {error && <span style={{ color: 'var(--erro)' }}>{error}</span>}
        </p>
        <button className="cta" type="submit" disabled={busy || !valida}>{busy ? '…' : t('gate.resetSave')}</button>
      </form>
      <footer className="foot"><span>{t('gate.title')}</span><LangToggle compact /></footer>
    </main>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const { t, tErr } = useT();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function swap() {
    setMode(mode === 'in' ? 'up' : 'in'); setError(null); setNotice(null);
  }

  // A MESMA régua do botão, no Enter também: o `onKeyDown` chamava `submit()`
  // sem conferir nada, e um e-mail inválido ou senha vazia ia pro servidor
  // (auditoria do portão, P5). Agora é um `<form>`, e o envio passa por aqui.
  const senhaOk = mode === 'up' ? password.length >= SENHA_MINIMA : password.length > 0;
  const podeEnviar = !busy && isValidEmail(email.trim()) && senhaOk;

  async function submit() {
    if (!podeEnviar) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'up') {
        const { needsConfirm } = await signUp(email.trim(), password);
        if (needsConfirm) {
          setNotice(t('gate.created'));
          setMode('in'); setBusy(false); return;
        }
      } else {
        await signIn(email.trim(), password);
      }
      onDone();
    } catch (e) { setError(tErr(e)); setBusy(false); }
  }

  async function google() {
    setBusy(true); setError(null); setNotice(null);
    try { await signInWithGoogle(); /* redireciona a página */ }
    catch (e) { setError(tErr(e)); setBusy(false); }
  }

  async function forgot() {
    if (!email.trim()) { setError(t('gate.emailFirst')); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await resetPassword(email.trim());
      setNotice(t('gate.resetSent'));
    } catch (e) { setError(tErr(e)); }
    finally { setBusy(false); }
  }

  return (
    <main className="shell">
      <header className="head">
        <span className="venue">Racha</span>
        <span className="mesa">{t('gate.ownerPanel')}</span>
      </header>
      <form className="card" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h1 className="label">{mode === 'in' ? t('gate.signIn') : t('gate.signUp')}</h1>

        {/* O Google só aparece com o cliente OAuth do PRÓPRIO Racha ligado — ver
            `GOOGLE_LIGADO` em auth.ts. O do Seatable mostrava o endereço cru do
            projeto dele na tela de autorização (auditoria do portão, P1). */}
        {GOOGLE_LIGADO && (
          <>
            <button type="button" className="ghost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 600 }}
              disabled={busy} onClick={google}>
              <span aria-hidden="true" style={{ fontWeight: 700, color: '#4285F4' }}>G</span> {t('gate.google')}
            </button>
            <div className="muted small" style={{ textAlign: 'center', margin: '2px 0' }}>{t('gate.orEmail')}</div>
          </>
        )}

        {/* `autoComplete` de verdade nos dois: é o que faz o gerenciador de
            senhas preencher e, no cadastro, OFERECER uma senha forte. Sem
            `username`/`new-password` o navegador guarda a senha na conta
            errada — e este formulário é o único caminho pro painel do dono. */}
        <Campo
          rotulo={t('gate.email')} type="email" inputMode="email"
          autoComplete="username" placeholder={t('gate.emailPlaceholder')}
          // Só depois de digitar algo: acusar um campo vazio que a pessoa nem
          // tocou é gritar antes de haver erro.
          ruim={email.trim().length > 0 && !isValidEmail(email.trim())}
          recado={email.trim().length > 0 && !isValidEmail(email.trim()) ? t('gate.emailInvalid') : undefined}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Campo
          rotulo={mode === 'up' ? t('gate.newPassword') : t('gate.password')} type="password"
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/* A regra da senha dita ANTES de enviar — a recusa vinha do servidor,
            crua e em inglês (auditoria do portão, P6). */}
        {mode === 'up' && <p className="muted small" style={{ margin: 0 }}>{t('gate.passwordRule', { n: String(SENHA_MINIMA) })}</p>}

        {/* `aria-live`: quem usa leitor de tela não vê a frase aparecer. Sem
            isto o único retorno de uma senha errada é visual. */}
        <p className="muted small" role="status" aria-live="polite" style={{ margin: 0 }}>
          {error && <span style={{ color: 'var(--erro)' }}>{error}</span>}
          {notice && <span style={{ color: 'var(--ok)' }}>{notice}</span>}
        </p>

        {/* O botão exige e-mail VÁLIDO, não só preenchido: antes um endereço
            com erro de digitação ia até o servidor e voltava como frase de
            autenticação genérica, que não diz qual campo consertar. */}
        <button className="cta" type="submit" disabled={!podeEnviar}>
          {busy ? '…' : (mode === 'in' ? t('gate.signIn') : t('gate.signUp'))}
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button type="button" className="linklike" onClick={swap}>
            {mode === 'in' ? t('gate.signUp') : t('gate.haveAccount')}
          </button>
          {mode === 'in' && <button type="button" className="linklike" onClick={forgot} disabled={busy}>{t('gate.forgot')}</button>}
        </div>
      </form>
      <footer className="foot"><span>{t('gate.title')}</span><LangToggle compact /></footer>
    </main>
  );
}
