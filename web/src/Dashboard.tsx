import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api, usd, ApiError, type Me, type ApiKeyRow, type Job, type ProviderEarnings, type Payout } from './api'
import { session } from './session'

/* ============================================================
   GpuGrid console - the developer + provider dashboards, wired
   to the live gateway. Reached from the landing via #/app and
   #/providers. Same dark/mono language as the site, no 3D.
   ============================================================ */

const ACCENT = '#5fd4e2'
const CORE = '#e6a44b'
const INK = '#e8f0f8'
const DIM = '#6a7d8e'
const PANEL: CSSProperties = {
  border: '1px solid rgba(140,158,176,.2)',
  borderRadius: 14,
  background: 'rgba(11,15,20,.9)',
  padding: 24,
}
const LABEL: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.16em', color: '#9fb4c6' }

function Btn({
  children,
  onClick,
  kind = 'cyan',
  disabled,
  style,
  href,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'cyan' | 'ghost' | 'danger'
  disabled?: boolean
  style?: CSSProperties
  href?: string
}) {
  const base: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    letterSpacing: '.04em',
    padding: '10px 16px',
    borderRadius: 9,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    transition: 'filter .2s, border-color .2s, background .2s',
    border: '1px solid transparent',
    ...(kind === 'cyan' && { background: ACCENT, color: '#06080b', border: `1px solid ${ACCENT}` }),
    ...(kind === 'ghost' && { background: 'transparent', color: INK, border: '1px solid rgba(140,158,176,.32)' }),
    ...(kind === 'danger' && { background: 'transparent', color: '#e8927a', border: '1px solid rgba(232,146,122,.4)' }),
    ...style,
  }
  if (href) return <a href={href} target="_blank" rel="noopener" className={`btn-${kind}`} style={base}>{children}</a>
  return (
    <button className={`btn-${kind}`} onClick={onClick} disabled={disabled} style={base}>
      {children}
    </button>
  )
}

function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Btn
      kind="ghost"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        })
      }}
      style={{ padding: '7px 12px', fontSize: 11 }}
    >
      {done ? '✓ Copied' : label}
    </Btn>
  )
}

function Field({ children }: { children: ReactNode }) {
  return (
    <code
      style={{
        flex: 1,
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: ACCENT,
        background: 'rgba(6,9,12,.8)',
        border: '1px solid rgba(140,158,176,.18)',
        borderRadius: 8,
        padding: '10px 13px',
        overflowX: 'auto',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </code>
  )
}

function Notice({ msg, kind }: { msg: string; kind: 'err' | 'ok' }) {
  if (!msg) return null
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        padding: '10px 14px',
        borderRadius: 9,
        marginBottom: 16,
        color: kind === 'err' ? '#f0a892' : ACCENT,
        background: kind === 'err' ? 'rgba(232,146,122,.08)' : 'rgba(95,212,226,.08)',
        border: `1px solid ${kind === 'err' ? 'rgba(232,146,122,.3)' : 'rgba(95,212,226,.3)'}`,
      }}
    >
      {msg}
    </div>
  )
}

function Steps({ items, accent = ACCENT }: { items: { title: string; body: ReactNode }[]; accent?: string }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {items.map((s, i) => (
        <li key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: '#06080b',
              background: accent,
              minWidth: 24,
              height: 24,
              borderRadius: 7,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              marginTop: 1,
            }}
          >
            {i + 1}
          </span>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: INK, marginBottom: 3 }}>{s.title}</div>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 14, color: '#9fb4c6', lineHeight: 1.55 }}>
              {s.body}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

const Mono = ({ children }: { children: ReactNode }) => (
  <code style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: ACCENT }}>{children}</code>
)

const fmtTime = (ms: number) => new Date(ms).toLocaleString()

/* ---------------- funding (pay into the on-chain contract) ---------------- */
// Non-custodial: funds go into the ggrid_payout escrow contract, which pays
// providers directly. We're just the router. Activates with the $GGRID launch.
function Funding() {
  return (
    <div style={PANEL}>
      <div style={{ ...LABEL, marginBottom: 16 }}>FUNDING</div>
      <p style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 14, color: '#9fb4c6', margin: '0 0 16px', lineHeight: 1.6 }}>
        Non-custodial by design: you deposit <b style={{ color: INK }}>$GGRID</b> straight into the on-chain
        escrow contract — <b style={{ color: INK }}>not to us</b>. As you use the API, the contract pays the GPU
        provider their <b style={{ color: INK }}>75%</b> directly. We only route your requests; we never hold your funds.
      </p>
      <Steps
        items={[
          { title: 'Deposit into the contract', body: 'Connect your wallet and fund the on-chain escrow — your balance lives in the contract, auditable by anyone.' },
          { title: 'Use the API', body: 'Each request draws from your on-chain deposit at the same per-token price.' },
          { title: 'Providers paid from the contract', body: <>The contract splits every job <Mono>75% provider · 12.5% burn · 7.5% stakers · 5% treasury</Mono> — enforced by code, not by us.</> },
        ]}
      />
      <div style={{ marginTop: 16 }}>
        <Notice kind="ok" msg="On-chain funding opens with the $GGRID token launch. Until then, the team can enable access for testing." />
      </div>
    </div>
  )
}

/* ---------------- developer dashboard ---------------- */
function Developer() {
  const [apiKey, setApiKey] = useState<string | null>(session.apiKey())
  const [me, setMe] = useState<Me | null>(null)
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [freshKey, setFreshKey] = useState<string | null>(null) // a just-created key (shown once)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pasteKey, setPasteKey] = useState('')

  const load = useCallback(async (token: string) => {
    setErr('')
    try {
      const [m, k, u] = await Promise.all([api.me(token), api.listKeys(token), api.usage(token)])
      setMe(m)
      setKeys(k.keys)
      setJobs(u.jobs)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setErr('That API key is invalid or revoked.')
        session.signOut()
        setApiKey(null)
      } else setErr(e instanceof Error ? e.message : 'failed to load')
    }
  }, [])

  useEffect(() => {
    if (apiKey) load(apiKey)
  }, [apiKey, load])

  async function createAccount() {
    setBusy(true)
    setErr('')
    try {
      const wallet = session.wallet() ?? undefined
      const r = await api.signup()
      session.signIn(r.apiKey, r.userId, wallet)
      setFreshKey(r.apiKey)
      setApiKey(r.apiKey)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'signup failed')
    } finally {
      setBusy(false)
    }
  }

  function restore() {
    const k = pasteKey.trim()
    if (!k) return
    session.signIn(k)
    setApiKey(k)
  }

  async function newKey() {
    if (!apiKey) return
    setBusy(true)
    try {
      const r = await api.createKey(apiKey, 'dashboard')
      setFreshKey(r.apiKey)
      await load(apiKey)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not create key')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    if (!apiKey) return
    await api.revokeKey(apiKey, id).catch(() => {})
    await load(apiKey)
  }

  const origin = window.location.origin

  // ---- logged out: get an API key ----
  if (!apiKey) {
    return (
      <div style={{ ...PANEL, maxWidth: 560 }}>
        <div style={LABEL}>DEVELOPER ACCESS</div>
        <h2 style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, margin: '12px 0 8px', color: INK }}>
          Get your API key
        </h2>
        <p style={{ fontFamily: 'var(--display)', fontWeight: 300, color: '#9fb4c6', margin: '0 0 22px', fontSize: 15, lineHeight: 1.6 }}>
          Create an account and get an OpenAI-compatible key with free trial credits. Point any OpenAI client at the grid.
        </p>
        <Notice msg={err} kind="err" />
        <Btn onClick={createAccount} disabled={busy}>
          {busy ? 'Creating…' : 'Create account → get key'}
        </Btn>
        <div style={{ marginTop: 28 }}>
          <div style={{ ...LABEL, marginBottom: 16 }}>HOW IT WORKS</div>
          <Steps
            items={[
              { title: 'Create an account', body: 'Get an OpenAI-compatible API key instantly, with free trial credits - no card.' },
              { title: 'Point your client at the grid', body: <>Base URL <Mono>{origin}/v1</Mono>, model <Mono>llama3:8b</Mono>.</> },
              { title: 'Pay only for what you use', body: 'Your requests run on community GPUs at a fraction of the usual price.' },
            ]}
          />
        </div>
        <div style={{ marginTop: 26, paddingTop: 22, borderTop: '1px solid rgba(140,158,176,.16)' }}>
          <div style={{ ...LABEL, marginBottom: 10 }}>ALREADY HAVE A KEY?</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              value={pasteKey}
              onChange={(e) => setPasteKey(e.target.value)}
              placeholder="ggrid_sk_…"
              style={{
                flex: 1,
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: INK,
                background: 'rgba(6,9,12,.8)',
                border: '1px solid rgba(140,158,176,.2)',
                borderRadius: 8,
                padding: '10px 13px',
              }}
            />
            <Btn kind="ghost" onClick={restore}>
              Use key
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  // ---- logged in ----
  const curl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${freshKey ?? (me ? apiKey : 'ggrid_sk_…')}" \\
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"hi"}]}'`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Notice msg={err} kind="err" />

      {/* account */}
      <div style={PANEL}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
          <div>
            <div style={LABEL}>ACCOUNT</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: INK, marginTop: 10, wordBreak: 'break-all' }}>
              {me?.userId ?? '-'}
            </div>
          </div>
          <button
            onClick={() => {
              session.signOut()
              setApiKey(null)
              setMe(null)
            }}
            className="link-dim"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: DIM, padding: 0, whiteSpace: 'nowrap' }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* funding — pay into the on-chain contract, not us */}
      <Funding />

      {/* freshly created key (shown once) */}
      {freshKey && (
        <div style={{ ...PANEL, borderColor: 'rgba(95,212,226,.45)' }}>
          <div style={{ ...LABEL, color: ACCENT }}>YOUR NEW KEY - COPY IT NOW (shown once)</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
            <Field>{freshKey}</Field>
            <Copy text={freshKey} />
          </div>
        </div>
      )}

      {/* getting started */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 18 }}>GETTING STARTED</div>
        <Steps
          items={[
            { title: 'Copy your API key', body: 'It is shown once when created. Lost it? Create a fresh one under API keys below.' },
            {
              title: 'Point your client at the grid',
              body: (
                <>
                  Set base URL <Mono>{origin}/v1</Mono> and model <Mono>llama3:8b</Mono>. Any OpenAI-compatible SDK or app
                  works unchanged - just swap the base URL and key.
                </>
              ),
            },
            { title: 'Send a request', body: 'Use the quickstart below, or your own client. The grid routes each call to an available GPU.' },
            { title: 'Track usage', body: 'Every call shows up in Recent requests with its tokens and cost.' },
          ]}
        />
      </div>

      {/* quickstart */}
      <div style={PANEL}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={LABEL}>QUICKSTART - TRY IT</div>
          <Copy text={curl} label="Copy curl" />
        </div>
        <pre
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: '#cdd9e4',
            background: 'rgba(6,9,12,.8)',
            border: '1px solid rgba(140,158,176,.16)',
            borderRadius: 8,
            padding: 16,
            marginTop: 12,
            overflowX: 'auto',
          }}
        >
          {curl}
        </pre>
      </div>

      {/* api keys */}
      <div style={PANEL}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={LABEL}>API KEYS</div>
          <Btn onClick={newKey} disabled={busy} style={{ padding: '8px 14px', fontSize: 11 }}>
            + New key
          </Btn>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {keys.filter((k) => !k.revoked_at).length === 0 && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>No active keys.</div>
          )}
          {keys.map((k) => (
            <div
              key={k.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '11px 14px',
                borderRadius: 9,
                background: 'rgba(6,9,12,.6)',
                border: '1px solid rgba(140,158,176,.14)',
                opacity: k.revoked_at ? 0.45 : 1,
              }}
            >
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: INK }}>
                {k.prefix}…
                <span style={{ color: DIM, marginLeft: 10 }}>{k.label ?? 'key'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: DIM }}>{fmtTime(k.created_at)}</span>
                {k.revoked_at ? (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: '#9a6d62' }}>revoked</span>
                ) : (
                  <button
                    onClick={() => revoke(k.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: '#c98873', padding: 0 }}
                  >
                    revoke
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* usage */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 14 }}>RECENT REQUESTS</div>
        {jobs.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>
            No requests yet - fire the curl above to see usage here.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
              <thead>
                <tr style={{ color: DIM, textAlign: 'left' }}>
                  {['MODEL', 'STATUS', 'TOK IN', 'TOK OUT', 'COST', 'SRC', 'WHEN'].map((h) => (
                    <th key={h} style={{ padding: '6px 10px 10px', fontWeight: 400, letterSpacing: '.08em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} style={{ borderTop: '1px solid rgba(140,158,176,.1)', color: '#bccadb' }}>
                    <td style={{ padding: '9px 10px', color: INK }}>{j.model}</td>
                    <td style={{ padding: '9px 10px', color: j.status === 'DONE' ? ACCENT : '#c98873' }}>{j.status}</td>
                    <td style={{ padding: '9px 10px' }}>{j.tokens_in}</td>
                    <td style={{ padding: '9px 10px' }}>{j.tokens_out}</td>
                    <td style={{ padding: '9px 10px' }}>{usd(j.cost)}</td>
                    <td style={{ padding: '9px 10px', color: DIM }}>{j.source}</td>
                    <td style={{ padding: '9px 10px', color: DIM }}>{fmtTime(j.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- provider dashboard ---------------- */
function Provider() {
  const [token, setToken] = useState<string | null>(session.providerToken())
  const [data, setData] = useState<ProviderEarnings | null>(null)
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [payoutsEnabled, setPayoutsEnabled] = useState(false)
  const [wallet, setWallet] = useState('')
  const [walletInput, setWalletInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [pasteTok, setPasteTok] = useState('')

  const load = useCallback(async (t: string) => {
    setErr('')
    try {
      const [e, p] = await Promise.all([api.providerEarnings(t), api.providerPayouts(t)])
      setData(e)
      setWallet(e.payoutWallet ?? '')
      setPayouts(p.payouts)
      setPayoutsEnabled(p.payoutsEnabled)
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 401) {
        setErr('That provider token is invalid.')
        session.clearProvider()
        setToken(null)
      } else setErr(ex instanceof Error ? ex.message : 'failed to load')
    }
  }, [])

  useEffect(() => {
    if (token) load(token)
  }, [token, load])

  async function become() {
    setBusy(true)
    setErr('')
    try {
      const r = await api.createProvider(session.wallet() ?? undefined)
      session.setProvider(r.providerToken, r.providerId)
      setToken(r.providerToken)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not register')
    } finally {
      setBusy(false)
    }
  }

  function restore() {
    const t = pasteTok.trim()
    if (!t) return
    session.setProvider(t)
    setToken(t)
  }

  async function saveWallet() {
    if (!token) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      await api.setProviderWallet(token, walletInput.trim())
      setOk('Payout wallet saved.')
      await load(token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'invalid wallet')
    } finally {
      setBusy(false)
    }
  }

  async function payout() {
    if (!token) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const r = await api.providerPayout(token)
      setOk(r?.signature ? `Payout sent: ${r.signature}` : r?.message ?? 'Payout requested.')
      await load(token)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'payout failed')
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <div style={{ ...PANEL, maxWidth: 560 }}>
        <div style={{ ...LABEL, color: CORE }}>PROVIDER</div>
        <h2 style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, margin: '12px 0 8px', color: INK }}>
          Put your GPU on the grid
        </h2>
        <p style={{ fontFamily: 'var(--display)', fontWeight: 300, color: '#9fb4c6', margin: '0 0 22px', fontSize: 15, lineHeight: 1.6 }}>
          Register a node, run the one-line installer, and earn 75% of every job it serves - paid in $GGRID.
        </p>
        <Notice msg={err} kind="err" />
        <Btn onClick={become} disabled={busy} style={{ background: CORE, borderColor: CORE }}>
          {busy ? 'Registering…' : 'Register a provider node'}
        </Btn>
        <div style={{ marginTop: 28 }}>
          <div style={{ ...LABEL, marginBottom: 16, color: CORE }}>HOW IT WORKS</div>
          <Steps
            accent={CORE}
            items={[
              { title: 'Register a node', body: 'Get a provider token that links every job - and its earnings - to you.' },
              { title: 'Run the one-line installer', body: 'On any machine with a GPU. It installs Ollama + a secure tunnel and joins the grid in under a minute.' },
              { title: 'Earn as it serves', body: 'You keep 75% of every job your GPU handles, paid in $GGRID.' },
            ]}
          />
        </div>
        <div style={{ marginTop: 26, paddingTop: 22, borderTop: '1px solid rgba(140,158,176,.16)' }}>
          <div style={{ ...LABEL, marginBottom: 10 }}>ALREADY HAVE A PROVIDER TOKEN?</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              value={pasteTok}
              onChange={(e) => setPasteTok(e.target.value)}
              placeholder="ggrid_pv_…"
              style={{
                flex: 1,
                fontFamily: 'var(--mono)',
                fontSize: 12,
                color: INK,
                background: 'rgba(6,9,12,.8)',
                border: '1px solid rgba(140,158,176,.2)',
                borderRadius: 8,
                padding: '10px 13px',
              }}
            />
            <Btn kind="ghost" onClick={restore}>
              Use token
            </Btn>
          </div>
        </div>
      </div>
    )
  }

  const origin = window.location.origin
  const install = `# Linux / macOS - installs Ollama + a secure tunnel, then joins the grid
curl -fsSL ${origin}/install.sh | PROVIDER_TOKEN=${token} bash

# Windows (PowerShell)
$env:PROVIDER_TOKEN="${token}"; irm ${origin}/install.ps1 | iex`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Notice msg={err} kind="err" />
      <Notice msg={ok} kind="ok" />

      {/* earnings */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 16 }}>
        <div style={PANEL}>
          <div style={LABEL}>UNPAID BALANCE</div>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 34, color: CORE, marginTop: 8 }}>
            {data ? usd(data.balance) : '-'}
          </div>
        </div>
        <div style={PANEL}>
          <div style={LABEL}>JOBS SERVED</div>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 34, color: INK, marginTop: 8 }}>
            {data?.jobsServed ?? '-'}
          </div>
        </div>
        <div style={PANEL}>
          <div style={LABEL}>TOTAL EARNED</div>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 34, color: INK, marginTop: 8 }}>
            {data ? usd(data.earned) : '-'}
          </div>
        </div>
      </div>

      {/* connect a node */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 18 }}>CONNECT A NODE</div>
        <Steps
          accent={CORE}
          items={[
            { title: 'Copy your provider token', body: 'It identifies your node and ties earnings to you - keep it secret.' },
            { title: 'Run the installer on a GPU machine', body: 'One line (below). It installs Ollama, opens a secure tunnel - no account needed - and registers your node.' },
            { title: 'Your node comes online', body: 'It shows up under Your nodes as online and starts serving jobs automatically. Keep the window open to stay online.' },
            { title: 'Earn 75% per job', body: <>Paid in $GGRID. Add your Solana wallet under <Mono>$GGRID Payouts</Mono> - withdrawals open when the token goes live.</> },
          ]}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22 }}>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: DIM, margin: 0 }}>Your provider token (keep it secret):</p>
          <Copy text={install} label="Copy command" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
          <Field>{token}</Field>
          <Copy text={token} />
        </div>
        <pre
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: '#cdd9e4',
            background: 'rgba(6,9,12,.8)',
            border: '1px solid rgba(140,158,176,.16)',
            borderRadius: 8,
            padding: 16,
            marginTop: 14,
            overflowX: 'auto',
          }}
        >
          {install}
        </pre>
      </div>

      {/* nodes */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 14 }}>YOUR NODES</div>
        {!data || data.nodes.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>
            No nodes yet - run the installer above to bring one online.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {data.nodes.map((n) => (
              <div
                key={n.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '11px 14px',
                  borderRadius: 9,
                  background: 'rgba(6,9,12,.6)',
                  border: '1px solid rgba(140,158,176,.14)',
                }}
              >
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: INK }}>
                  {(n.models ?? []).join(', ') || n.id}
                </div>
                <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--mono)', fontSize: 11, color: DIM }}>
                  {n.region && <span>{n.region}</span>}
                  {typeof n.reliability === 'number' && <span>rel {(n.reliability * 100).toFixed(0)}%</span>}
                  <span style={{ color: n.online ? ACCENT : '#9a6d62' }}>{n.online ? 'online' : 'offline'}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* payouts */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 14 }}>$GGRID PAYOUTS</div>
        {!payoutsEnabled && (
          <Notice
            msg="On-chain payouts aren't enabled on this gateway yet - earnings accrue and are paid once the $GGRID splitter goes live on mainnet."
            kind="ok"
          />
        )}
        <div style={{ ...LABEL, marginBottom: 8 }}>PAYOUT WALLET (Solana)</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <input
            value={walletInput}
            onChange={(e) => setWalletInput(e.target.value)}
            placeholder={wallet || 'your Solana address'}
            style={{
              flex: 1,
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: INK,
              background: 'rgba(6,9,12,.8)',
              border: '1px solid rgba(140,158,176,.2)',
              borderRadius: 8,
              padding: '10px 13px',
            }}
          />
          <Btn kind="ghost" onClick={saveWallet} disabled={busy}>
            Save
          </Btn>
        </div>
        <Btn onClick={payout} disabled={busy || !payoutsEnabled} style={{ background: CORE, borderColor: CORE }}>
          Withdraw as $GGRID
        </Btn>

        {payouts.length > 0 && (
          <div style={{ marginTop: 20, overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 12 }}>
              <thead>
                <tr style={{ color: DIM, textAlign: 'left' }}>
                  {['AMOUNT', 'STATUS', 'TX', 'WHEN'].map((h) => (
                    <th key={h} style={{ padding: '6px 10px 10px', fontWeight: 400, letterSpacing: '.08em' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} style={{ borderTop: '1px solid rgba(140,158,176,.1)', color: '#bccadb' }}>
                    <td style={{ padding: '9px 10px', color: INK }}>{usd(p.net_credits)}</td>
                    <td style={{ padding: '9px 10px' }}>{p.status}</td>
                    <td style={{ padding: '9px 10px', color: DIM, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {p.signature ?? '-'}
                    </td>
                    <td style={{ padding: '9px 10px', color: DIM }}>{fmtTime(p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- shell + router ---------------- */
export default function Dashboard({ tab }: { tab: 'app' | 'providers' }) {
  return (
    <div className="console-enter" style={{ minHeight: '100vh', background: '#070b10', position: 'relative', zIndex: 1 }}>
      {/* header */}
      <header
        className="console-header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 5vw',
          background: 'rgba(7,11,16,.82)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderBottom: '1px solid rgba(140,158,176,.14)',
        }}
      >
        <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
          <img src="/logo.png" alt="" width={34} height={34} style={{ borderRadius: 8, border: '1px solid rgba(140,158,176,.3)' }} />
          <span className="console-brand-text" style={{ fontFamily: 'var(--display)', fontWeight: 500, letterSpacing: '.16em', fontSize: 14, color: INK }}>
            GPUGRID
          </span>
        </a>
        <nav style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {(['app', 'providers'] as const).map((t) => (
            <a
              key={t}
              href={`#/${t}`}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 12,
                letterSpacing: '.04em',
                padding: '8px 14px',
                borderRadius: 8,
                textDecoration: 'none',
                color: tab === t ? '#06080b' : '#9fb4c6',
                background: tab === t ? ACCENT : 'transparent',
              }}
            >
              {t === 'app' ? 'Developers' : 'Providers'}
            </a>
          ))}
          <a href="#/" className="link-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM, textDecoration: 'none', marginLeft: 8 }}>
            ← Site
          </a>
        </nav>
      </header>

      <main className="console-main" style={{ maxWidth: 980, margin: '0 auto', padding: '40px 5vw 90px' }}>
        {/* keyed by tab so the entrance animation replays on every switch */}
        <div key={tab} className="console-tab">{tab === 'app' ? <Developer /> : <Provider />}</div>
      </main>
    </div>
  )
}
