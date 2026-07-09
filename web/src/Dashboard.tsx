import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { api, usd, ggrid, ApiError, type Me, type ApiKeyRow, type Job, type ProviderEarnings, type Payout, type GpuNode, type WalletBalance, type Stats } from './api'
import { session } from './session'

// Resolves the current bearer credential for authenticated /api calls: a live
// Privy access token when logged in via Privy, else a pasted ggrid_sk_ key.
type GetToken = () => Promise<string | null>

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
  position: 'relative',
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,.06)',
  borderRadius: 18,
  background: 'linear-gradient(180deg, #181a1f 0%, #131418 100%)',
  boxShadow: '0 12px 34px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.04)',
  padding: 24,
}
const LABEL: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.16em', color: '#9fb4c6' }

/* ================= glass-bento dashboard primitives ================= */
const VIOLET = '#8b6cff'
const BLUE = '#4f9dff'
const CARD: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,.06)',
  borderRadius: 22,
  background: 'linear-gradient(180deg, #181a1f 0%, #131418 100%)',
  padding: 22,
  boxShadow: '0 12px 34px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.04)',
}
const CARD_TITLE: CSSProperties = { fontFamily: 'var(--display)', fontSize: 15.5, color: '#cbd8e6', fontWeight: 400 }
const CARD_SUB: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.06em', color: '#8496a8' }

// Circular progress ring with a gradient stroke + glow. `gid` must be unique per use.
function Ring({ pct, size = 150, stroke = 13, from, to, gid, children }: { pct: number; size?: number; stroke?: number; from: string; to: string; gid: string; children?: ReactNode }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const off = c * (1 - Math.max(0, Math.min(1, pct)))
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={from} />
            <stop offset="100%" stopColor={to} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} style={{ transition: 'stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)', filter: `drop-shadow(0 0 6px ${from}66)` }} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  )
}

// A smooth path (Catmull-Rom → bezier) through points.
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return ''
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    d += ` C ${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`
  }
  return d
}

// Glowing sparkline with a soft area fill and a bright end dot.
function GlowLine({ data, h = 92, color = BLUE, gid }: { data: number[]; h?: number; color?: string; gid: string }) {
  const w = 340
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const span = max - min || 1
  const pts: [number, number][] = data.map((v, i) => [(i / Math.max(1, data.length - 1)) * w, h - 6 - ((v - min) / span) * (h - 16)])
  const line = smoothPath(pts)
  const area = `${line} L ${w},${h} L 0,${h} Z`
  const last = pts[pts.length - 1] ?? [w, h]
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`${gid}a`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <filter id={`${gid}g`} x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="3.4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d={area} fill={`url(#${gid}a)`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" filter={`url(#${gid}g)`} />
      <circle cx={last[0]} cy={last[1]} r="3.4" fill="#eaf4ff" style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
    </svg>
  )
}

// Weekly bar chart; the tallest (or given) bar is highlighted with a tooltip.
function Bars({ data, labels, highlight, unit = '' }: { data: number[]; labels: string[]; highlight: number; unit?: string }) {
  const max = Math.max(...data, 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8, height: 132 }}>
      {data.map((v, i) => {
        const on = i === highlight
        return (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, height: '100%' }}>
            <div style={{ position: 'relative', flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
              {on && v > 0 && (
                <div style={{ position: 'absolute', top: 0, fontFamily: 'var(--mono)', fontSize: 10.5, color: '#eaf4ff', background: 'rgba(59,130,246,.92)', padding: '3px 7px', borderRadius: 7, whiteSpace: 'nowrap' }}>
                  {v}
                  {unit}
                </div>
              )}
              <div
                style={{
                  width: 11,
                  height: `${Math.max(6, (v / max) * 78)}%`,
                  borderRadius: 7,
                  background: on ? 'linear-gradient(180deg,#8fd0ff,#3b82f6)' : 'linear-gradient(180deg, rgba(120,190,255,.85), rgba(59,130,246,.22))',
                  boxShadow: on ? '0 0 16px rgba(80,160,255,.55)' : 'none',
                  transition: 'height .5s ease',
                }}
              />
            </div>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: on ? '#cfe0f2' : DIM }}>{labels[i]}</span>
          </div>
        )
      })}
    </div>
  )
}

// A soft glowing wave line (status / mood).
function Wave({ color = ACCENT, gid }: { color?: string; gid: string }) {
  return (
    <svg width="100%" height="66" viewBox="0 0 300 66" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <filter id={gid} x="-10%" y="-80%" width="120%" height="260%">
          <feGaussianBlur stdDeviation="2.8" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d="M0,42 C40,18 70,56 110,38 C150,20 180,8 220,30 C255,48 280,28 300,34" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" filter={`url(#${gid})`} />
    </svg>
  )
}

// Minimal feather-style line icons for the shortcut tiles.
const ICONS: Record<string, ReactNode> = {
  docs: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M10.85 12.15 19 4" /><path d="m18 5 2 2" /><path d="m15 8 2 2" /></>,
  chip: <><rect x="6" y="6" width="12" height="12" rx="1.5" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></>,
  chart: <><path d="M3 3v18h18" /><path d="m7 14 3-3 3 3 5-6" /></>,
  signal: <><path d="M4 20v-6M10 20V8M16 20v-9M22 20V5" /></>,
}
function ShortcutTile({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="shortcut-tile" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, padding: '15px 8px', borderRadius: 16, cursor: 'pointer', border: '1px solid rgba(255,255,255,.06)', background: '#1c1e24', color: '#c1d1e2' }}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {ICONS[icon]}
      </svg>
      <span style={{ fontFamily: 'var(--display)', fontSize: 12.5 }}>{label}</span>
    </button>
  )
}

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

const fmtTime = (ms: number) => new Date(ms).toLocaleString('en-US')

/* ---------------- funding (pay into the on-chain contract) ---------------- */
// Non-custodial: the developer deposits $GGRID straight into the ggrid_payout
// vault - the same pool providers are paid from. We build the deposit tx server
// side, the wallet signs+sends it, and we credit the balance once it lands.
function Funding({ getToken, balance, rate, onCredited }: { getToken: GetToken; balance?: number; rate: number; onCredited: () => void }) {
  const [tokens, setTokens] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')

  async function topUp() {
    setErr('')
    setOk('')
    const amt = Number(tokens)
    const authToken = await getToken()
    if (!authToken) return setErr('Sign in first so credits have somewhere to land.')
    if (!Number.isFinite(amt) || amt <= 0) return setErr('Enter how much $GGRID to deposit.')

    // DEV ONLY (vite dev server): simulate the deposit with no wallet / no chain
    // so the funding flow is testable locally. Never runs in a production build.
    if ((import.meta as any).env?.DEV) {
      setBusy(true)
      try {
        const st = await api.creditsDevTopup(authToken, amt)
        setOk(`(dev) Credited ${ggrid(st.credits ?? 0, rate)} - new balance ${ggrid(st.balance ?? 0, rate)}.`)
        setTokens('')
        onCredited()
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'dev top-up failed')
      } finally {
        setBusy(false)
      }
      return
    }

    const sol = (window as any).solana
    if (!sol?.isPhantom) {
      window.open('https://phantom.app/', '_blank', 'noopener')
      return setErr('Connect a Phantom wallet to pay in $GGRID.')
    }
    setBusy(true)
    try {
      const conn = await sol.connect()
      const wallet = conn.publicKey.toString()
      // 1. gateway builds the unsigned deposit tx + a unique reference
      const intent = await api.creditsIntent(authToken, wallet, amt)
      // 2. deserialize, let the wallet sign + send it
      const web3 = await import('@solana/web3.js')
      const bytes = Uint8Array.from(atob(intent.transaction), (ch) => ch.charCodeAt(0))
      const tx = web3.Transaction.from(bytes)
      setOk('Approve the deposit in your wallet…')
      await sol.signAndSendTransaction(tx)
      // 3. poll until the gateway sees the deposit and credits us
      setOk('Payment sent - waiting for on-chain confirmation…')
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        const st = await api.creditsStatus(authToken, intent.reference)
        if (st.status === 'CONFIRMED') {
          setOk(`Credited ${ggrid(st.credits ?? intent.credits, rate)} - new balance ${ggrid(st.balance ?? 0, rate)}.`)
          setTokens('')
          onCredited()
          setBusy(false)
          return
        }
      }
      setOk('Deposit sent. It can take a moment to credit - reopen the console shortly.')
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setErr('On-chain top-ups aren’t enabled on this gateway yet.')
      else setErr(e instanceof Error ? e.message : 'top-up failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={PANEL}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div style={LABEL}>BALANCE</div>
        <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, color: ACCENT }}>
          {typeof balance === 'number' ? ggrid(balance, rate) : '-'}
        </div>
      </div>
      <p style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 14, color: '#9fb4c6', margin: '14px 0 16px', lineHeight: 1.6 }}>
        Non-custodial: your <b style={{ color: INK }}>$GGRID</b> goes straight into the on-chain vault -
        <b style={{ color: INK }}> not to us</b>. Each request draws from your balance; the contract pays the GPU
        provider their <b style={{ color: INK }}>75%</b> directly. We only route requests.
      </p>

      <Notice msg={err} kind="err" />
      <Notice msg={ok} kind="ok" />

      <div style={{ ...LABEL, marginBottom: 8 }}>TOP UP WITH $GGRID</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <input
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          placeholder="amount of $GGRID"
          inputMode="decimal"
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
        <Btn onClick={topUp} disabled={busy}>
          {busy ? 'Working…' : 'Pay with $GGRID'}
        </Btn>
      </div>

      <Steps
        items={[
          { title: 'Deposit $GGRID', body: 'Connect your wallet and deposit - your balance lands in the on-chain vault, auditable by anyone.' },
          { title: 'Use the API', body: 'Each request draws from your balance at the same per-token price.' },
          { title: 'Providers paid from the vault', body: <>Every job splits <Mono>75% provider · 12.5% burn · 7.5% stakers · 5% treasury</Mono> - enforced by code, not by us.</> },
        ]}
      />
    </div>
  )
}

/* ---------------- developer dashboard ---------------- */
/* ---------------- GPU marketplace (pick a specific node) ---------------- */
// Public catalogue of live GPUs. Developers can pin a request to one node with
// the `x-ggrid-node` header instead of letting the auto-router choose. Reads
// /api/nodes (no auth) and builds a copy-paste curl for the chosen GPU.
function Marketplace({ origin, apiKeyHint }: { origin: string; apiKeyHint: string }) {
  const [nodes, setNodes] = useState<GpuNode[] | null>(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr('')
    try {
      const r = await api.nodes()
      setNodes(r.nodes)
      // keep a valid pick; drop it if the node went away
      setPicked((p) => (p && r.nodes.some((n) => n.id === p) ? p : null))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not load GPUs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const sel = nodes?.find((n) => n.id === picked) ?? null
  const model = sel?.models[0] ?? 'llama3:8b'
  const pinCurl = sel
    ? `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${apiKeyHint}" \\
  -H "x-ggrid-node: ${sel.id}" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}]}'`
    : ''

  const stat = (label: string, value: ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.12em', color: DIM }}>{label}</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: INK }}>{value}</span>
    </div>
  )

  return (
    <div style={PANEL}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={LABEL}>GPU MARKETPLACE</div>
        <button
          onClick={load}
          disabled={loading}
          className="link-dim"
          style={{ background: 'none', border: 'none', cursor: loading ? 'default' : 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: DIM, padding: 0 }}
        >
          {loading ? 'refreshing…' : '↻ refresh'}
        </button>
      </div>
      <p style={{ fontFamily: 'var(--display)', fontWeight: 300, color: '#9fb4c6', margin: '0 0 18px', fontSize: 14, lineHeight: 1.6 }}>
        By default the grid auto-routes each request to the best available GPU. Want a specific one? Pick it below and add
        the <Mono>x-ggrid-node</Mono> header - your call runs on exactly that node.
      </p>

      <Notice msg={err} kind="err" />

      {nodes === null ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>Loading GPUs…</div>
      ) : nodes.length === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>
          No GPUs online right now. Requests still work - the auto-router will use the cloud fallback where allowed.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {nodes.map((n) => {
            const active = n.id === picked
            const busy = n.freeSlots === 0
            return (
              <button
                key={n.id}
                onClick={() => setPicked(active ? null : n.id)}
                className="tier-btn"
                style={{
                  textAlign: 'left',
                  cursor: 'pointer',
                  padding: '14px 16px',
                  borderRadius: 11,
                  background: active ? 'rgba(95,212,226,.06)' : 'rgba(6,9,12,.6)',
                  border: `1px solid ${active ? 'rgba(95,212,226,.55)' : 'rgba(140,158,176,.14)'}`,
                  transition: 'border-color .2s, background .2s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: n.online ? '#57d38a' : '#6a7d8e',
                        boxShadow: n.online ? '0 0 8px rgba(87,211,138,.8)' : 'none',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ fontFamily: 'var(--display)', fontSize: 16, color: INK }}>{n.gpu}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', color: DIM, border: '1px solid rgba(140,158,176,.22)', borderRadius: 5, padding: '2px 6px' }}>
                      {n.source}
                    </span>
                    {n.backend === 'metal' && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', color: '#c7b3ff', border: '1px solid rgba(160,130,255,.4)', borderRadius: 5, padding: '2px 6px' }}>
                        METAL
                      </span>
                    )}
                    {(n.fanless || n.thermalLimited) && (
                      <span
                        title="Fanless / throttles under sustained load - best for short bursts, not long streaming jobs."
                        style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', color: '#ffb570', border: '1px solid rgba(255,150,60,.45)', borderRadius: 5, padding: '2px 6px' }}
                      >
                        BURST
                      </span>
                    )}
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: active ? ACCENT : DIM }}>
                    {active ? '✓ pinned' : busy ? 'at capacity' : 'pick'}
                  </span>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {n.models.map((m) => (
                    <span key={m} style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: '#bccadb', background: 'rgba(140,158,176,.1)', borderRadius: 6, padding: '3px 8px' }}>
                      {m}
                    </span>
                  ))}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 12 }}>
                  {stat('PRICE', `${n.priceFactor.toFixed(2)}×`)}
                  {stat('SPEED', n.perfTokensPerSec > 0 ? `${n.perfTokensPerSec} tok/s` : '-')}
                  {stat('RELIABILITY', `${Math.round(n.reliability * 100)}%`)}
                  {stat('UPTIME', `${n.uptimePct}%`)}
                  {stat('FREE SLOTS', `${n.freeSlots}`)}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {sel && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ ...LABEL, color: ACCENT }}>PINNED TO {sel.gpu.toUpperCase()}</div>
            <Copy text={pinCurl} label="Copy curl" />
          </div>
          <pre
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12.5,
              lineHeight: 1.7,
              color: '#cdd9e4',
              background: 'rgba(6,9,12,.8)',
              border: '1px solid rgba(95,212,226,.2)',
              borderRadius: 8,
              padding: 16,
              overflowX: 'auto',
            }}
          >
            {pinCurl}
          </pre>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: DIM }}>Just the header:</span>
            <Field>{`x-ggrid-node: ${sel.id}`}</Field>
            <Copy text={`x-ggrid-node: ${sel.id}`} />
          </div>
          <p style={{ fontFamily: 'var(--display)', fontWeight: 300, color: DIM, margin: '12px 0 0', fontSize: 12.5, lineHeight: 1.6 }}>
            A pinned request runs only on this GPU - no auto-fallback. If it's offline or busy you'll get a 409, so drop
            the header to let the grid route for you.
          </p>
        </div>
      )}
    </div>
  )
}

function Developer() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy()
  const [sessionKey, setSessionKey] = useState<string | null>(() => session.apiKey()) // pasted-key fallback
  const [me, setMe] = useState<Me | null>(null)
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [freshKey, setFreshKey] = useState<string | null>(null) // a just-created key (shown once)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [pasteKey, setPasteKey] = useState('')
  const [rate, setRate] = useState(0.000001) // $GGRID per credit; refreshed from /api/pricing
  const [section, setSection] = useState('overview') // active dashboard section
  const [walletBal, setWalletBal] = useState<WalletBalance | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)

  // The user's Solana wallet: Privy's embedded/linked Solana wallet (base58, not an
  // 0x EVM address), or a wallet stored from a pasted-key/Phantom session.
  const walletAddr = useMemo(() => {
    const accts = ((user?.linkedAccounts ?? []) as any[]).filter(
      (a) => a?.type === 'wallet' && typeof a?.address === 'string',
    )
    const sol = accts.find((a) => a.chainType === 'solana') ?? accts.find((a) => !a.address.startsWith('0x'))
    return sol?.address ?? session.wallet() ?? null
  }, [user])

  // Load the token conversion rate so balances show in $GGRID (public, no auth).
  useEffect(() => {
    api
      .pricing()
      .then((p) => setRate(p.ggrid.tokensPerCredit))
      .catch(() => {})
  }, [])

  // Live grid stats for the overview cards (public, no auth).
  useEffect(() => {
    api.stats().then(setStats).catch(() => {})
  }, [])

  // Derived numbers + chart series for the glass-bento overview.
  const ov = useMemo(() => {
    const activeKeys = keys.filter((k) => !k.revoked_at).length
    const total = jobs.length
    const done = jobs.filter((j) => !/err|fail/i.test(j.status || '')).length
    const successPct = total ? done / total : 0
    const week = [0, 0, 0, 0, 0, 0, 0] // Mon..Sun
    for (const j of jobs) week[(new Date(j.created_at).getDay() + 6) % 7]++
    const hi = week.reduce((m, v, i) => (v > week[m] ? i : m), 0)
    // hero line: real per-day series if there's enough, else a gentle default shape
    const line = total >= 3 ? week.slice() : [4, 6, 5, 8, 7, 10, 9, 12, 10, 14]
    const tokens = (me?.balance ?? 0) * rate
    const balPct = tokens > 0 ? tokens / (tokens + 1000) : 0
    const d = new Date()
    const hr = d.getHours()
    const greet = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'
    const name = me?.email ? me.email.split('@')[0] : 'Developer'
    const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', weekday: 'short' })
    return { activeKeys, total, done, successPct, week, hi, line, tokens, balPct, greet, name, timeStr, dateStr }
  }, [keys, jobs, me, rate])

  // Read the wallet's REAL on-chain $GGRID balance whenever the address changes.
  useEffect(() => {
    if (!walletAddr) {
      setWalletBal(null)
      return
    }
    let cancelled = false
    api
      .walletBalance(walletAddr)
      .then((b) => !cancelled && setWalletBal(b))
      .catch(() => !cancelled && setWalletBal(null))
    return () => {
      cancelled = true
    }
  }, [walletAddr])

  const loggedIn = authenticated || !!sessionKey

  // Credential for authenticated /api calls: a live Privy token, or the pasted key.
  const getToken = useCallback<GetToken>(async () => {
    if (authenticated) {
      try {
        return await getAccessToken()
      } catch {
        return null
      }
    }
    return sessionKey
  }, [authenticated, sessionKey, getAccessToken])

  const load = useCallback(async () => {
    setErr('')
    const token = await getToken()
    if (!token) return
    try {
      const [m, k, u] = await Promise.all([api.me(token), api.listKeys(token), api.usage(token)])
      setMe(m)
      setKeys(k.keys)
      setJobs(u.jobs)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        if (sessionKey) {
          setErr('That API key is invalid or revoked.')
          session.signOut()
          setSessionKey(null)
        } else setErr('Session expired - sign in again.')
      } else setErr(e instanceof Error ? e.message : 'failed to load')
    }
  }, [getToken, sessionKey])

  // On Privy login: ensure the GGRID account exists (created with free credits on
  // first login), then load. The Privy token then authenticates every call.
  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    ;(async () => {
      try {
        const token = await getAccessToken()
        if (!token || cancelled) return
        const r = await api.authPrivy(token)
        if (cancelled) return
        if (r.isNew && r.apiKey) setFreshKey(r.apiKey)
        await load()
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'sign-in failed')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated])

  // Pasted-key session (no Privy): load when the key changes.
  useEffect(() => {
    if (sessionKey && !authenticated) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, authenticated])

  function restore() {
    const k = pasteKey.trim()
    if (!k) return
    session.signIn(k)
    setSessionKey(k)
  }

  async function newKey() {
    const token = await getToken()
    if (!token) return
    setBusy(true)
    try {
      const r = await api.createKey(token, 'dashboard')
      setFreshKey(r.apiKey)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not create key')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    const token = await getToken()
    if (!token) return
    await api.revokeKey(token, id).catch(() => {})
    await load()
  }

  async function signOut() {
    if (authenticated) {
      try {
        await logout()
      } catch {
        /* ignore */
      }
    }
    session.signOut()
    setSessionKey(null)
    setMe(null)
    setKeys([])
    setJobs([])
    setFreshKey(null)
  }

  const origin = window.location.origin

  // ---- logged out: sign in via Privy ----
  if (!loggedIn) {
    return (
      <ConsoleShell tab="app" accent={ACCENT} nav={[]} active="" onNav={() => {}} title="Sign in">
      <div style={{ ...PANEL, maxWidth: 560 }}>
        <div style={LABEL}>DEVELOPER ACCESS</div>
        <h2 style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, margin: '12px 0 8px', color: INK }}>
          Sign in to GpuGrid
        </h2>
        <p style={{ fontFamily: 'var(--display)', fontWeight: 300, color: '#9fb4c6', margin: '0 0 22px', fontSize: 15, lineHeight: 1.6 }}>
          One account for everything - email, Google, or a wallet. New accounts get an OpenAI-compatible key with free
          trial credits. Point any OpenAI client at the grid.
        </p>
        <Notice msg={err} kind="err" />
        <Btn onClick={login} disabled={!ready}>
          {ready ? 'Sign in / Sign up' : 'Loading…'}
        </Btn>
        <div style={{ marginTop: 28 }}>
          <div style={{ ...LABEL, marginBottom: 16 }}>HOW IT WORKS</div>
          <Steps
            items={[
              { title: 'Sign in', body: 'Log in with email, Google, or a wallet - an account and API key are created for you, with free trial credits.' },
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
      </ConsoleShell>
    )
  }

  // ---- logged in: dashboard ----
  const curl = `curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ${freshKey ?? 'ggrid_sk_…'}" \\
  -d '{"model":"llama3:8b","messages":[{"role":"user","content":"hi"}]}'`

  const nav = [
    { id: 'overview', label: 'Overview' },
    { id: 'billing', label: 'Billing & credits' },
    { id: 'keys', label: 'API keys' },
    { id: 'market', label: 'GPU marketplace' },
    { id: 'usage', label: 'Recent requests' },
  ]
  const titles: Record<string, string> = {
    overview: 'Overview', billing: 'Billing & credits', keys: 'API keys', market: 'GPU marketplace', usage: 'Recent requests',
  }

  return (
    <ConsoleShell
      tab="app"
      accent={ACCENT}
      nav={nav}
      active={section}
      onNav={setSection}
      title={titles[section] ?? 'Console'}
      action={
        <button onClick={signOut} className="link-dim" style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: DIM, padding: 0 }}>
          Sign out
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Notice msg={err} kind="err" />

        {/* freshly created key (shown once, on any section) */}
        {freshKey && (
          <div style={{ ...PANEL, borderColor: 'rgba(95,212,226,.45)' }}>
            <div style={{ ...LABEL, color: ACCENT }}>YOUR NEW KEY - COPY IT NOW (shown once)</div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
              <Field>{freshKey}</Field>
              <Copy text={freshKey} />
            </div>
          </div>
        )}

        {section === 'overview' && (
          <div className="bento">
            {/* greeting + activity line */}
            <div style={{ ...CARD, gridColumn: 'span 4', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', minHeight: 214 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={CARD_SUB}>{ov.greet},</div>
                  <div style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: 34, color: INK, marginTop: 4, lineHeight: 1.05 }}>{ov.name}</div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: '#9fb4c6', marginTop: 8, maxWidth: 300, lineHeight: 1.5 }}>
                    Point any OpenAI-compatible client at the grid and ship.
                  </div>
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#c6d5e6', background: 'rgba(255,255,255,.06)', border: '1px solid rgba(150,170,205,.16)', padding: '5px 11px', borderRadius: 20, whiteSpace: 'nowrap' }}>{ov.timeStr}</span>
              </div>
              <div style={{ margin: '10px -6px -4px' }}>
                <GlowLine data={ov.line} gid="hero" color={BLUE} />
              </div>
            </div>

            {/* network / grid snapshot */}
            <div style={{ ...CARD, gridColumn: 'span 2' }}>
              <div style={CARD_SUB}>{ov.dateStr}</div>
              <div style={{ ...CARD_TITLE, marginTop: 2 }}>Network</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 16 }}>
                <div style={{ width: 46, height: 46, borderRadius: 13, display: 'grid', placeItems: 'center', background: 'rgba(95,212,226,.12)', border: '1px solid rgba(95,212,226,.3)', color: ACCENT }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{ICONS.chip}</svg>
                </div>
                <div>
                  <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 40, color: INK, lineHeight: 1 }}>{stats?.onlineNodes ?? '-'}</div>
                  <div style={CARD_SUB}>GPUs online</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 22, marginTop: 20 }}>
                <div>
                  <div style={CARD_SUB}>MODELS</div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 19, color: '#dbe6f2', marginTop: 3 }}>{stats?.models?.length ?? '-'}</div>
                </div>
                <div>
                  <div style={CARD_SUB}>USERS</div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 19, color: '#dbe6f2', marginTop: 3 }}>{stats?.users ?? '-'}</div>
                </div>
              </div>
            </div>

            {/* requests success ring */}
            <div style={{ ...CARD, gridColumn: 'span 4', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 18 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={CARD_TITLE}>Requests</div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: '#9fb4c6', background: 'rgba(255,255,255,.05)', padding: '3px 9px', borderRadius: 20 }}>This week</span>
                </div>
                <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 52, color: INK, marginTop: 14, lineHeight: 1 }}>{Math.round(ov.successPct * 100)}%</div>
                <div style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: ACCENT, marginTop: 4 }}>{ov.total ? 'Success rate' : 'No requests yet'}</div>
                <div style={{ display: 'flex', gap: 28, marginTop: 22 }}>
                  <div>
                    <div style={CARD_SUB}>COMPLETED</div>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 26, color: INK, marginTop: 3 }}>{ov.done}</div>
                  </div>
                  <div>
                    <div style={CARD_SUB}>TOTAL</div>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 26, color: INK, marginTop: 3 }}>{ov.total}</div>
                  </div>
                </div>
              </div>
              <Ring pct={ov.total ? ov.successPct : 0} from={ACCENT} to={VIOLET} gid="usage" size={152}>
                <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 27, color: INK }}>{ov.total ? Math.round(ov.successPct * 100) + '%' : '-'}</div>
                <div style={CARD_SUB}>ok</div>
              </Ring>
            </div>

            {/* balance gauge (focus-timer analog) */}
            <div style={{ ...CARD, gridColumn: 'span 2', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ alignSelf: 'stretch', ...CARD_TITLE }}>Balance</div>
              <div style={{ marginTop: 12 }}>
                <Ring pct={ov.balPct} from={CORE} to="#ffd79a" gid="bal" size={148}>
                  <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: ov.tokens >= 100000 ? 22 : 26, color: INK, lineHeight: 1 }}>
                    {ov.tokens.toLocaleString('en-US', { maximumFractionDigits: ov.tokens > 0 && ov.tokens < 1 ? 4 : 0 })}
                  </div>
                  <div style={CARD_SUB}>$GGRID</div>
                </Ring>
              </div>
              <button onClick={() => setSection('billing')} style={{ marginTop: 16, fontFamily: 'var(--mono)', fontSize: 12, color: '#06080b', background: CORE, border: 'none', borderRadius: 20, padding: '8px 22px', cursor: 'pointer' }}>
                ＋ Top up
              </button>
            </div>

            {/* getting started checklist */}
            <div style={{ ...CARD, gridColumn: 'span 3' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={CARD_TITLE}>Getting started</div>
                <button onClick={() => setSection('keys')} style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 18, lineHeight: 1, padding: 0 }}>+</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 16 }}>
                {[
                  { t: 'Create an API key', done: !!(freshKey || keys.some((k) => !k.revoked_at)) },
                  { t: 'Point a client at the grid', done: ov.total > 0 },
                  { t: 'Send your first request', done: ov.total > 0 },
                  { t: 'Add credits', done: (me?.balance ?? 0) > 5_000_000 },
                ].map((task) => {
                  const state = task.done ? 'Completed' : 'Pending'
                  const col = task.done ? '#4fd1a0' : DIM
                  return (
                    <div key={task.t} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid rgba(150,170,205,.07)' }}>
                      <span style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', border: task.done ? 'none' : '1.5px solid rgba(150,170,205,.35)', background: task.done ? 'linear-gradient(135deg,#4f9dff,#8b6cff)' : 'transparent' }}>
                        {task.done && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        )}
                      </span>
                      <span style={{ flex: 1, fontFamily: 'var(--display)', fontSize: 14, color: task.done ? '#a9bccb' : INK }}>{task.t}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: col }}>{state}</span>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* grid status wave */}
            <div style={{ ...CARD, gridColumn: 'span 3', display: 'flex', flexDirection: 'column' }}>
              <div style={CARD_TITLE}>Grid status</div>
              <div style={{ fontFamily: 'var(--display)', fontSize: 20, color: ACCENT, marginTop: 4 }}>{stats && stats.onlineNodes > 0 ? 'Healthy' : 'Warming up'}</div>
              <div style={{ flex: 1, minHeight: 66, display: 'flex', alignItems: 'center', margin: '6px -4px' }}>
                <Wave color={ACCENT} gid="statuswave" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={CARD_SUB}>Errors</span>
                <span style={{ fontFamily: 'var(--display)', fontSize: 14, color: ov.successPct >= 0.99 ? '#4fd1a0' : '#e6b04b' }}>{ov.total ? (ov.successPct >= 0.99 ? 'Low' : 'Some') : 'None'}</span>
              </div>
            </div>

            {/* weekly activity bars */}
            <div style={{ ...CARD, gridColumn: 'span 3' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div style={CARD_TITLE}>Weekly activity</div>
                <span style={CARD_SUB}>Requests</span>
              </div>
              <Bars data={ov.week} labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']} highlight={ov.hi} />
            </div>

            {/* shortcuts */}
            <div style={{ ...CARD, gridColumn: 'span 3' }}>
              <div style={{ ...CARD_TITLE, marginBottom: 16 }}>Shortcuts</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
                <ShortcutTile icon="docs" label="Docs" onClick={() => { window.location.hash = '#/docs' }} />
                <ShortcutTile icon="key" label="API keys" onClick={() => setSection('keys')} />
                <ShortcutTile icon="chip" label="GPUs" onClick={() => setSection('market')} />
                <ShortcutTile icon="card" label="Billing" onClick={() => setSection('billing')} />
                <ShortcutTile icon="chart" label="Usage" onClick={() => setSection('usage')} />
                <ShortcutTile icon="signal" label="Status" onClick={() => { window.location.hash = '#/stats' }} />
              </div>
            </div>

            {/* recent requests */}
            <div style={{ ...CARD, gridColumn: 'span 3' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                <div style={CARD_TITLE}>Recent requests</div>
                <button onClick={() => setSection('usage')} style={{ background: 'none', border: 'none', color: ACCENT, cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, padding: 0 }}>View all</button>
              </div>
              {jobs.length === 0 ? (
                <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM, padding: '10px 0' }}>No requests yet - send one from the quickstart.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {jobs.slice(0, 4).map((j) => {
                    const ok = !/err|fail/i.test(j.status || '')
                    return (
                      <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(150,170,205,.07)' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: ok ? '#4fd1a0' : '#e6774b', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: 'var(--display)', fontSize: 14, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.model}</div>
                          <div style={CARD_SUB}>{new Date(j.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#9fb4c6' }}>{usd(j.cost)}</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* system status */}
            <div style={{ ...CARD, gridColumn: 'span 3', display: 'flex', gap: 20, alignItems: 'center' }}>
              <Ring pct={ov.total ? ov.successPct : stats && stats.onlineNodes > 0 ? 1 : 0.06} from={BLUE} to={ACCENT} gid="sys" size={128} stroke={12}>
                <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 22, color: INK }}>{ov.total ? Math.round(ov.successPct * 100) + '%' : 'OK'}</div>
                <div style={CARD_SUB}>optimal</div>
              </Ring>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ ...CARD_TITLE, marginBottom: 2 }}>System status</div>
                {[
                  { k: 'Success', pct: ov.total ? ov.successPct : 1, label: ov.total ? Math.round(ov.successPct * 100) + '%' : '100%' },
                  { k: 'Online GPUs', pct: Math.min(1, (stats?.onlineNodes ?? 0) / 8), label: String(stats?.onlineNodes ?? 0) },
                  { k: 'Models', pct: Math.min(1, (stats?.models?.length ?? 0) / 8), label: String(stats?.models?.length ?? 0) },
                ].map((row) => (
                  <div key={row.k}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span style={CARD_SUB}>{row.k}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#c6d5e6' }}>{row.label}</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,.06)', overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${Math.max(4, row.pct * 100)}%`, borderRadius: 4, background: 'linear-gradient(90deg,#4f9dff,#5fd4e2)', transition: 'width .6s ease' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === 'billing' && <Funding getToken={getToken} balance={me?.balance} rate={rate} onCredited={load} />}

        {section === 'market' && <Marketplace origin={origin} apiKeyHint={freshKey ?? 'ggrid_sk_…'} />}

        {section === 'keys' && (
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
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 14px',
                    borderRadius: 9, background: 'rgba(6,9,12,.6)', border: '1px solid rgba(140,158,176,.14)', opacity: k.revoked_at ? 0.45 : 1,
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
        )}

        {section === 'usage' && (
          <div style={PANEL}>
            <div style={{ ...LABEL, marginBottom: 14 }}>RECENT REQUESTS</div>
            {jobs.length === 0 ? (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>
                No requests yet - fire a request to see usage here.
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
        )}
      </div>
    </ConsoleShell>
  )
}

/* ---------------- provider: shared building blocks ---------------- */
// Rough single-GPU throughput for llama3:8b (q4) - for the earnings estimate only.
const GPU_TIERS = [
  { name: 'RTX 3060 (12 GB)', tps: 30 },
  { name: 'RTX 4070 / 4070 Ti', tps: 55 },
  { name: 'Apple M2 / M3 (Max)', tps: 55 },
  { name: 'RTX 4090 (24 GB)', tps: 110 },
  { name: 'A100 / H100', tps: 160 },
]
// $ per 1,000,000 tokens from a credits/1M price (1 credit = 1 micro-USD).
const per1M = (credits: number) => `$${(credits / 1_000_000).toFixed(2)}`

const HERO: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,.07)',
  borderRadius: 22,
  background: 'linear-gradient(180deg, #1a1c22 0%, #131418 100%)',
  boxShadow: '0 16px 44px rgba(0,0,0,.46), inset 0 1px 0 rgba(255,255,255,.05)',
  padding: 30,
}
const H1: CSSProperties = { fontFamily: 'var(--display)', fontWeight: 300, fontSize: 38, color: INK, margin: '12px 0 10px', lineHeight: 1.08 }
const LEAD: CSSProperties = { fontFamily: 'var(--display)', fontWeight: 300, fontSize: 16, color: '#9fb4c6', lineHeight: 1.6, margin: 0 }

function TrustRow() {
  const items: [string, string, string][] = [
    ['75%', 'of every job is yours', CORE],
    ['On-chain', 'split enforced by the contract', ACCENT],
    ['Non-custodial', 'paid to your wallet, never held by us', CORE],
    ['Instant', 'withdraw $GGRID whenever you want', ACCENT],
  ]
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14 }}>
      {items.map(([big, sub, col]) => (
        <div key={sub} style={{ ...PANEL, padding: 18 }}>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 24, color: col }}>{big}</div>
          <div style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: '#9fb4c6', marginTop: 4, lineHeight: 1.45 }}>{sub}</div>
        </div>
      ))}
    </div>
  )
}

function Slider({ label, value, min, max, suffix, step = 1, onChange }: { label: string; value: number; min: number; max: number; suffix: string; step?: number; onChange: (n: number) => void }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ ...LABEL, fontSize: 10 }}>{label}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: INK }}>{value}{suffix}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: CORE, cursor: 'pointer' }} />
    </div>
  )
}

// Honest, data-driven estimate. Payment is PER TOKEN served, not hourly - so the
// only real driver is how many tokens the grid routes to your node each day. The
// GPU only caps how many it can physically serve at full load.
function EarningsCalculator() {
  const [tier, setTier] = useState(3) // RTX 4090
  const [mtok, setMtok] = useState(1.4) // millions of tokens served per day
  const [outPer1M, setOutPer1M] = useState(150_000) // llama3:8b output default

  useEffect(() => {
    api.pricing()
      .then((p) => { const m = p.models.find((x) => x.model === 'llama3:8b'); if (m) setOutPer1M(m.out) })
      .catch(() => {})
  }, [])

  const tps = GPU_TIERS[tier].tps
  const maxMtok = Math.round((tps * 86400) / 1e5) / 10 // theoretical max M tok/day at full load (1 decimal)
  const served = Math.min(mtok, maxMtok)
  const tokensPerDay = served * 1e6
  const usdPerToken = outPer1M / 1e12 // credits per 1M tokens → USD per token
  const perDay = tokensPerDay * usdPerToken * 0.75
  const perMonth = perDay * 30
  const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

  return (
    <div style={PANEL}>
      <div style={{ ...LABEL, color: CORE, marginBottom: 4 }}>EARNINGS ESTIMATE</div>
      <p style={{ fontFamily: 'var(--display)', fontSize: 14, color: '#9fb4c6', margin: '0 0 18px' }}>
        You are paid per token you serve, not per hour - so earnings track how many tokens the grid routes to your node.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,240px)', gap: 22, alignItems: 'center' }} className="calc-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ ...LABEL, fontSize: 10, marginBottom: 6 }}>YOUR GPU</div>
            <select
              value={tier}
              onChange={(e) => setTier(Number(e.target.value))}
              style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 13, color: INK, background: 'rgba(6,9,12,.85)', border: '1px solid rgba(140,158,176,.24)', borderRadius: 8, padding: '10px 12px' }}
            >
              {GPU_TIERS.map((g, i) => <option key={g.name} value={i}>{g.name}</option>)}
            </select>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: DIM, marginTop: 6 }}>
              Can serve up to ≈ {maxMtok}M tokens/day at full load.
            </div>
          </div>
          <Slider label="TOKENS SERVED / DAY" value={served} min={0.1} max={maxMtok} step={0.1} suffix="M" onChange={setMtok} />
        </div>
        <div style={{ textAlign: 'center', padding: '10px 8px', borderRadius: 12, background: 'rgba(230,164,75,.07)', border: '1px solid rgba(230,164,75,.22)' }}>
          <div style={{ ...LABEL, fontSize: 10 }}>EST. EARNINGS</div>
          <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 42, color: CORE, lineHeight: 1.1, marginTop: 6 }}>{money(perMonth)}</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: DIM, letterSpacing: '.08em' }}>PER MONTH</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#9fb4c6', marginTop: 10 }}>≈ {money(perDay)} / day</div>
        </div>
      </div>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: DIM, margin: '16px 0 0', lineHeight: 1.55 }}>
        Estimate only · your 75% share of llama3:8b at {per1M(outPer1M)}/1M output tokens · paid in $GGRID. Idle time pays
        nothing - you earn only while actually generating tokens.
      </p>
    </div>
  )
}

function Requirements() {
  const reqs: [string, string][] = [
    ['GPU', 'NVIDIA with 8 GB+ VRAM, or an Apple Silicon Mac (M4 / M5). More VRAM / memory runs bigger models.'],
    ['OS', 'Windows (PowerShell) or macOS (Apple Silicon) - a one-line installer for each.'],
    ['Software', 'Ollama + a secure Cloudflare tunnel, both installed automatically. No account, no port-forwarding.'],
    ['Uptime', 'Keep the window open to stay online. The more reliable you are, the more jobs route to you.'],
  ]
  return (
    <div style={PANEL}>
      <div style={{ ...LABEL, marginBottom: 16 }}>WHAT YOU NEED</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: 12 }}>
        {reqs.map(([k, v]) => (
          <div key={k} style={{ padding: '14px 15px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.14)' }}>
            <div style={{ ...LABEL, fontSize: 10, color: CORE, marginBottom: 6 }}>{k.toUpperCase()}</div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 14, color: '#cdd9e4', lineHeight: 1.5 }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ---------------- provider dashboard ---------------- */
function Provider() {
  const { ready, authenticated, login, logout, getAccessToken } = usePrivy()
  const [pastedToken, setPastedToken] = useState<string | null>(() => session.providerToken()) // paste-token fallback
  const [data, setData] = useState<ProviderEarnings | null>(null)
  const [payouts, setPayouts] = useState<Payout[]>([])
  const [payoutsEnabled, setPayoutsEnabled] = useState(false)
  const [wallet, setWallet] = useState('')
  const [walletInput, setWalletInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [pasteTok, setPasteTok] = useState('')
  const [section, setSection] = useState('overview') // active dashboard section
  const [nodeToken, setNodeToken] = useState<string | null>(() => session.providerToken()) // installer credential (shown once)

  const loggedIn = authenticated || !!pastedToken

  // Bearer for provider API calls: a live Privy token, or the pasted provider token.
  // requireProvider on the gateway accepts either.
  const getToken = useCallback<GetToken>(async () => {
    if (authenticated) {
      try {
        return await getAccessToken()
      } catch {
        return null
      }
    }
    return pastedToken
  }, [authenticated, pastedToken, getAccessToken])

  const load = useCallback(async () => {
    setErr('')
    const t = await getToken()
    if (!t) return
    try {
      const [e, p] = await Promise.all([api.providerEarnings(t), api.providerPayouts(t)])
      setData(e)
      setWallet(e.payoutWallet ?? '')
      setPayouts(p.payouts)
      setPayoutsEnabled(p.payoutsEnabled)
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 401) {
        if (pastedToken) {
          setErr('That provider token is invalid.')
          session.clearProvider()
          setPastedToken(null)
        } else setErr('Session expired - sign in again.')
      } else setErr(ex instanceof Error ? ex.message : 'failed to load')
    }
  }, [getToken, pastedToken])

  // On Privy login: ensure a provider exists for this identity, then load. The first
  // login returns the node token once - keep it for the installer.
  useEffect(() => {
    if (!authenticated) return
    let cancelled = false
    ;(async () => {
      try {
        const jwt = await getAccessToken()
        if (!jwt || cancelled) return
        const r = await api.authPrivyProvider(jwt)
        if (cancelled) return
        if (r.isNew && r.providerToken) setNodeToken(r.providerToken)
        await load()
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'sign-in failed')
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated])

  // Pasted-token session (no Privy): load when it changes.
  useEffect(() => {
    if (pastedToken && !authenticated) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedToken, authenticated])

  // Issue a fresh node token for the installer (Privy providers never see one otherwise).
  async function genNodeToken() {
    const t = await getToken()
    if (!t) return
    setBusy(true)
    setErr('')
    try {
      const r = await api.providerNodeToken(t)
      setNodeToken(r.providerToken)
      setOk('New node token generated - use it in the installer below. The previous one is now revoked.')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'could not generate a node token')
    } finally {
      setBusy(false)
    }
  }

  function restore() {
    const t = pasteTok.trim()
    if (!t) return
    session.setProvider(t)
    setPastedToken(t)
    setNodeToken(t)
  }

  async function saveWallet() {
    const t = await getToken()
    if (!t) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      await api.setProviderWallet(t, walletInput.trim())
      setOk('Payout wallet saved.')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'invalid wallet')
    } finally {
      setBusy(false)
    }
  }

  async function payout() {
    const t = await getToken()
    if (!t) return
    setBusy(true)
    setErr('')
    setOk('')
    try {
      const r = await api.providerPayout(t)
      setOk(r?.signature ? `Payout sent: ${r.signature}` : r?.message ?? 'Payout requested.')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'payout failed')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (authenticated) {
      try {
        await logout()
      } catch {
        /* ignore */
      }
    }
    session.clearProvider()
    setPastedToken(null)
    setNodeToken(null)
    setData(null)
    setPayouts([])
  }

  if (!loggedIn) {
    const onbNav = [
      { id: 'overview', label: 'Overview' },
      { id: 'earnings', label: 'Earnings estimate' },
      { id: 'how', label: 'How it works' },
      { id: 'requirements', label: 'Requirements' },
      { id: 'start', label: 'Get started' },
    ]
    const onbTitles: Record<string, string> = {
      overview: 'Overview', earnings: 'Earnings estimate', how: 'How it works', requirements: 'Requirements', start: 'Get started',
    }
    const onb = onbNav.some((n) => n.id === section) ? section : 'overview'

    return (
      <ConsoleShell
        tab="providers"
        accent={CORE}
        nav={onbNav}
        active={onb}
        onNav={setSection}
        title={onbTitles[onb]}
        action={
          <Btn onClick={login} disabled={!ready} style={{ background: CORE, borderColor: CORE, padding: '8px 16px', fontSize: 12 }}>
            {ready ? 'Sign in to start earning' : 'Loading…'}
          </Btn>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {err && <Notice msg={err} kind="err" />}

          {onb === 'overview' && (
            <>
              {/* hero */}
              <div style={HERO}>
                <div style={{ ...LABEL, color: CORE }}>BECOME A PROVIDER</div>
                <h1 style={H1}>Turn your idle GPU into income</h1>
                <p style={{ ...LEAD, maxWidth: 620 }}>
                  Put any GPU on the grid in under a minute. It serves AI requests and you keep{' '}
                  <b style={{ color: INK }}>75% of every job</b> - paid in $GGRID, withdrawn on-chain whenever you want.
                </p>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 22 }}>
                  <Btn onClick={login} disabled={!ready} style={{ background: CORE, borderColor: CORE, padding: '12px 20px' }}>
                    {ready ? 'Sign in to start earning' : 'Loading…'}
                  </Btn>
                  <a href="#/docs" className="link-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#9fb4c6', textDecoration: 'none' }}>
                    Read the full guide →
                  </a>
                </div>
              </div>
              <TrustRow />
              <button
                onClick={() => setSection('earnings')}
                style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, color: CORE, padding: 0 }}
              >
                See what a node can earn →
              </button>
            </>
          )}

          {onb === 'earnings' && <EarningsCalculator />}

          {onb === 'how' && (
            <div style={PANEL}>
              <div style={{ ...LABEL, marginBottom: 16, color: CORE }}>HOW IT WORKS</div>
              <Steps
                accent={CORE}
                items={[
                  { title: 'Register a node', body: 'One click gives you a provider token that ties every job - and its earnings - to you.' },
                  { title: 'Run the one-line installer', body: 'On any machine with a GPU. It installs Ollama + a secure tunnel and joins the grid in under a minute.' },
                  { title: 'Your node serves jobs', body: 'It appears online and the grid starts routing requests to it automatically.' },
                  { title: 'Earn 75%, withdraw anytime', body: 'Add a Solana wallet and withdraw your $GGRID on-chain whenever you like.' },
                ]}
              />
            </div>
          )}

          {onb === 'requirements' && <Requirements />}

          {onb === 'start' && (
            <div style={PANEL}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
                <div>
                  <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 20, color: INK }}>Ready to earn?</div>
                  <div style={{ fontFamily: 'var(--display)', fontSize: 14, color: '#9fb4c6', marginTop: 2 }}>Sign in and bring a GPU online with one command.</div>
                </div>
                <Btn onClick={login} disabled={!ready} style={{ background: CORE, borderColor: CORE }}>
                  {ready ? 'Sign in to start earning' : 'Loading…'}
                </Btn>
              </div>
              <div style={{ marginTop: 22, paddingTop: 20, borderTop: '1px solid rgba(140,158,176,.16)' }}>
                <div style={{ ...LABEL, marginBottom: 10 }}>ALREADY HAVE A PROVIDER TOKEN?</div>
                <div style={{ display: 'flex', gap: 10, maxWidth: 480 }}>
                  <input
                    value={pasteTok}
                    onChange={(e) => setPasteTok(e.target.value)}
                    placeholder="ggrid_pv_…"
                    style={{ flex: 1, fontFamily: 'var(--mono)', fontSize: 12, color: INK, background: 'rgba(6,9,12,.8)', border: '1px solid rgba(140,158,176,.2)', borderRadius: 8, padding: '10px 13px' }}
                  />
                  <Btn kind="ghost" onClick={restore}>Use token</Btn>
                </div>
              </div>
            </div>
          )}
        </div>
      </ConsoleShell>
    )
  }

  const origin = window.location.origin
  const install = `# Windows (PowerShell) - installs Ollama + a secure tunnel, then joins the grid
$env:PROVIDER_TOKEN="${nodeToken}"; irm ${origin}/install.ps1 | iex

# macOS - Apple Silicon (M4 / M5). Hardware-verified on connect; a MacBook Air runs
# but throttles under sustained load (flagged "burst") - a cooled Mac earns more.
curl -fsSL ${origin}/install.sh | PROVIDER_TOKEN=${nodeToken} bash`

  const nav = [
    { id: 'overview', label: 'Overview' },
    { id: 'nodes', label: 'Your nodes' },
    { id: 'installer', label: 'Connect a node' },
    { id: 'payouts', label: '$GGRID payouts' },
  ]
  const titles: Record<string, string> = {
    overview: 'Overview', nodes: 'Your nodes', installer: 'Connect a node', payouts: '$GGRID payouts',
  }

  return (
    <ConsoleShell
      tab="providers"
      accent={CORE}
      nav={nav}
      active={section}
      onNav={setSection}
      title={titles[section] ?? 'Provider'}
      action={
        <a href="#/docs" className="link-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM, textDecoration: 'none' }}>
          Provider guide →
        </a>
      }
      footer={
        <button onClick={disconnect} className="link-dim" style={{ textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 12, color: DIM, padding: 0 }}>
          Disconnect node
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Notice msg={err} kind="err" />
        <Notice msg={ok} kind="ok" />

        {section === 'overview' && (
          <>
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
            <div style={PANEL}>
              <div style={{ ...LABEL, marginBottom: 8, color: CORE }}>ONLINE NODES</div>
              <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 20, color: INK }}>
                {data ? `${data.nodes.filter((n) => n.online).length} of ${data.nodes.length} node(s) online` : '-'}
              </div>
              <p style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: '#9fb4c6', margin: '10px 0 0', lineHeight: 1.6 }}>
                Manage them under <b style={{ color: INK }}>Your nodes</b>, or bring a new GPU online from <b style={{ color: INK }}>Connect a node</b>.
                You earn 75% of every job, withdrawn as $GGRID under <b style={{ color: INK }}>$GGRID payouts</b>.
              </p>
            </div>
          </>
        )}

        {section === 'installer' && (
          <div style={PANEL}>
            <div style={{ ...LABEL, marginBottom: 18 }}>CONNECT A NODE</div>
            <Steps
              accent={CORE}
              items={[
                { title: 'Generate a node token', body: 'It identifies your node and ties earnings to your account - keep it secret.' },
                { title: 'Run the installer on a GPU machine', body: 'One line (below). It installs Ollama, opens a secure tunnel - no account needed - and registers your node.' },
                { title: 'Your node comes online', body: 'It shows up under Your nodes as online and starts serving jobs automatically. Keep the window open to stay online.' },
                { title: 'Earn 75% per job', body: <>Paid in $GGRID. Add your Solana wallet under <Mono>$GGRID payouts</Mono> - withdrawals open when the token goes live.</> },
              ]}
            />
            {!nodeToken ? (
              <div style={{ marginTop: 22, padding: '16px 18px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.16)' }}>
                <div style={{ ...LABEL, marginBottom: 8, color: CORE }}>NODE TOKEN</div>
                <p style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: '#9fb4c6', margin: '0 0 14px', lineHeight: 1.6 }}>
                  Generate a node token to drop into the installer. It ties every job on that machine to your account. Shown
                  once - generating again revokes the previous one.
                </p>
                <Btn onClick={genNodeToken} disabled={busy} style={{ background: CORE, borderColor: CORE }}>
                  {busy ? 'Generating…' : 'Generate node token'}
                </Btn>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 22, gap: 12, flexWrap: 'wrap' }}>
                  <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: DIM, margin: 0 }}>Your node token (keep it secret):</p>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button onClick={genNodeToken} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: DIM, padding: 0 }}>
                      Regenerate
                    </button>
                    <Copy text={install} label="Copy command" />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 8, alignItems: 'center' }}>
                  <Field>{nodeToken}</Field>
                  <Copy text={nodeToken} />
                </div>
                <pre
                  style={{
                    fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.7, color: '#cdd9e4',
                    background: 'rgba(6,9,12,.8)', border: '1px solid rgba(140,158,176,.16)', borderRadius: 8, padding: 16, marginTop: 14, overflowX: 'auto',
                  }}
                >
                  {install}
                </pre>
              </>
            )}
          </div>
        )}

        {section === 'nodes' && (
          <div style={PANEL}>
            <div style={{ ...LABEL, marginBottom: 14 }}>YOUR NODES</div>
            {!data || data.nodes.length === 0 ? (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM }}>
                No nodes yet - run the installer under Connect a node to bring one online.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.nodes.map((n) => (
                  <div
                    key={n.id}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 14px',
                      borderRadius: 9, background: 'rgba(6,9,12,.6)', border: '1px solid rgba(140,158,176,.14)',
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
        )}

        {section === 'payouts' && (
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
                  flex: 1, fontFamily: 'var(--mono)', fontSize: 12, color: INK,
                  background: 'rgba(6,9,12,.8)', border: '1px solid rgba(140,158,176,.2)', borderRadius: 8, padding: '10px 13px',
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
        )}
      </div>
    </ConsoleShell>
  )
}

/* ---------------- console chrome ---------------- */
// Dashboard shell (RunPod-style): persistent left sidebar with the
// Developer/Provider switch + section nav; sticky top bar; scrollable content.
function ConsoleShell({
  tab, accent, nav, active, onNav, title, action, footer, children,
}: {
  tab: 'app' | 'providers'
  accent: string
  nav: { id: string; label: string }[]
  active: string
  onNav: (id: string) => void
  title: string
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="dash-grid">
      <aside className="dash-side">
      <div className="dash-side-inner">
        <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', padding: '2px 6px 18px' }}>
          <img src="/logo.png" alt="" width={30} height={30} style={{ borderRadius: 8, border: '1px solid rgba(140,158,176,.3)' }} />
          <span style={{ fontFamily: 'var(--display)', fontWeight: 500, letterSpacing: '.16em', fontSize: 14, color: INK }}>GPUGRID</span>
        </a>

        <div className="dash-switch">
          {(['app', 'providers'] as const).map((t) => (
            <a
              key={t}
              href={`#/${t}`}
              className="dash-switch-btn"
              style={{ color: tab === t ? '#06080b' : '#9fb4c6', background: tab === t ? accent : 'transparent' }}
            >
              {t === 'app' ? 'Developer' : 'Provider'}
            </a>
          ))}
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 22 }}>
          {nav.map((item) => {
            const on = item.id === active
            return (
              <button
                key={item.id}
                onClick={() => onNav(item.id)}
                className="dash-navlink"
                style={{ borderLeft: `2px solid ${on ? accent : 'transparent'}`, color: on ? accent : '#9fb4c6', background: on ? `${accent}14` : 'transparent' }}
              >
                {item.label}
              </button>
            )
          })}
        </nav>

        <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: '1px solid rgba(140,158,176,.12)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {footer}
          <a href="#/" className="link-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM, textDecoration: 'none' }}>← Back to site</a>
        </div>
      </div>
      </aside>

      <main className="dash-main">
        <header className="dash-topbar">
          <div style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: 20, color: INK }}>{title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>{action}</div>
        </header>
        <div key={active} className="console-tab dash-content">{children}</div>
      </main>
    </div>
  )
}

/* ---------------- shell + router ---------------- */
export default function Dashboard({ tab }: { tab: 'app' | 'providers' }) {
  return (
    <div className="console-enter" style={{ minHeight: '100vh', background: '#0a0b0e', position: 'relative', zIndex: 1 }}>
      {/* clean dark backdrop: warm orange light bleeding in from the right,
          a faint cool wash top-right - no 3D scene, no particles. */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(46% 56% at 100% 62%, rgba(255,138,58,.20) 0%, rgba(236,116,44,.07) 42%, transparent 70%),' +
            'radial-gradient(40% 34% at 100% 0%, rgba(72,118,214,.12) 0%, transparent 60%),' +
            'radial-gradient(60% 50% at 8% 8%, rgba(30,34,44,.5) 0%, transparent 60%)',
        }}
      />
      {/* each tab renders its own chrome: TopChrome (logged-out) or the
          dashboard ConsoleShell (logged-in) */}
      {tab === 'app' ? <Developer /> : <Provider />}
    </div>
  )
}
