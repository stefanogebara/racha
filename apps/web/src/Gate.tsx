import { useEffect, useState, type ReactNode } from 'react';
import { onSession, signIn, supabase } from './auth';

/**
 * Owner login gate — wraps the restaurant surfaces (/admin, /painel). Diners
 * never see this: the conta flow is public. Until there's a session, renders
 * the login form; once logged in, renders children.
 */
export default function Gate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => onSession((s) => { setAuthed(!!s); setReady(true); }), []);

  if (!supabase) {
    return <main className="shell"><section className="card"><p className="muted center">
      Login não configurado (defina VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).
    </p></section></main>;
  }
  if (!ready) return <main className="shell"><p className="muted center">carregando…</p></main>;
  return authed ? <>{children}</> : <Login onDone={() => setAuthed(true)} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null);
    try { await signIn(email.trim(), password); onDone(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <main className="shell">
      <header className="head">
        <span className="venue">Racha</span>
        <span className="mesa">painel do dono</span>
      </header>
      <section className="card">
        <p className="label">Entrar</p>
        <input className="namefield" type="email" placeholder="e-mail" value={email}
          onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <input className="namefield" type="password" placeholder="senha" value={password}
          onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {error && <p className="muted small" style={{ color: 'var(--burgundy)' }}>{error}</p>}
        <button className="cta" disabled={busy || !email.trim() || !password} onClick={submit}>
          {busy ? 'entrando…' : 'Entrar'}
        </button>
      </section>
      <footer className="foot"><span>racha · área do restaurante</span></footer>
    </main>
  );
}
