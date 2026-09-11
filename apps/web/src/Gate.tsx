import { useEffect, useState, type ReactNode } from 'react';
import { useT, LangToggle } from './lang';
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

        <input className="namefield" type="email" placeholder={t('gate.email')} value={email}
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <input className="namefield" type="password" placeholder={mode === 'up' ? t('gate.newPassword') : t('gate.password')} value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />

        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        {notice && <p className="muted small" style={{ color: 'var(--green, #15803d)' }}>{notice}</p>}

        <button className="cta" disabled={busy || !email.trim() || !password} onClick={submit}>
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
