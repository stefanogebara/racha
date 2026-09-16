import { useEffect, useState, type ReactNode } from 'react';
import { useT, LangToggle } from './lang';
import { Campo } from './Campo';
import { isValidEmail } from './br';
import { onSession, signIn, signUp, signInWithGoogle, resetPassword, supabase } from './auth';

/**
 * Owner login gate — wraps the restaurant surfaces (/admin, /painel). Diners
 * never see this: the conta flow is public. Until there's a session, renders
 * the login form; once logged in, renders children.
 */
export default function Gate({ children }: { children: ReactNode }) {
  const { t } = useT();
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => onSession((s) => { setAuthed(!!s); setReady(true); }), []);

  if (!supabase) {
    return <main className="shell"><section className="card"><p className="muted center">
      {t('gate.notConfigured')}
    </p></section></main>;
  }
  if (!ready) return <main className="shell"><p className="muted center">{t('admin.loading')}</p></main>;
  return authed ? <>{children}</> : <Login onDone={() => setAuthed(true)} />;
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

  async function submit() {
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
      <section className="card">
        <p className="label">{mode === 'in' ? t('gate.signIn') : t('gate.signUp')}</p>

        <button className="ghost" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontWeight: 600 }}
          disabled={busy} onClick={google}>
          <span aria-hidden="true" style={{ fontWeight: 700, color: '#4285F4' }}>G</span> {t('gate.google')}
        </button>
        <div className="muted small" style={{ textAlign: 'center', margin: '2px 0' }}>{t('gate.orEmail')}</div>

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
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <Campo
          rotulo={mode === 'up' ? t('gate.newPassword') : t('gate.password')} type="password"
          autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        />

        {/* `aria-live`: quem usa leitor de tela não vê a frase aparecer. Sem
            isto o único retorno de uma senha errada é visual. */}
        <p className="muted small" role="status" aria-live="polite" style={{ margin: 0 }}>
          {error && <span style={{ color: 'var(--erro)' }}>{error}</span>}
          {notice && <span style={{ color: 'var(--ok)' }}>{notice}</span>}
        </p>

        {/* O botão exige e-mail VÁLIDO, não só preenchido: antes um endereço
            com erro de digitação ia até o servidor e voltava como frase de
            autenticação genérica, que não diz qual campo consertar. */}
        <button className="cta" disabled={busy || !isValidEmail(email.trim()) || !password} onClick={submit}>
          {busy ? '…' : (mode === 'in' ? t('gate.signIn') : t('gate.signUp'))}
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button className="linklike" onClick={swap}>
            {mode === 'in' ? t('gate.signUp') : t('gate.haveAccount')}
          </button>
          {mode === 'in' && <button className="linklike" onClick={forgot} disabled={busy}>{t('gate.forgot')}</button>}
        </div>
      </section>
      <footer className="foot"><span>{t('gate.title')}</span><LangToggle compact /></footer>
    </main>
  );
}
