import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api, usd, type Pricing as PricingData, type Stats, type GpuNode, type TokenInfo } from './api'

// The staking panel lives in the (heavy) console module; lazy-load it so the light
// public pages don't pull in Privy/3D. Same <Staking /> the developer console mounts.
const StakingPanel = lazy(() => import('./Dashboard').then((m) => ({ default: m.Staking })))

/* ============================================================
   Public content pages: Pricing, API docs, Network stats.
   Reached from the landing via #/pricing, #/docs, #/stats.
   Same dark/mono language as the console, no 3D - fast to load.
   ============================================================ */

const ACCENT = '#5fd4e2'
const CORE = '#e6a44b'
const INK = '#e8f0f8'
const DIM = '#6a7d8e'
const SUB = '#9fb4c6'
const PANEL: CSSProperties = {
  border: '1px solid rgba(140,158,176,.2)',
  borderRadius: 14,
  background: 'rgba(11,15,20,.9)',
  padding: 24,
}
const LABEL: CSSProperties = { fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.16em', color: SUB }
const H2: CSSProperties = { fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, color: INK, margin: '0 0 8px' }
const LEAD: CSSProperties = { fontFamily: 'var(--display)', fontWeight: 300, fontSize: 16, color: SUB, lineHeight: 1.6, margin: 0 }
const NAV: { id: PageId; label: string }[] = [
  { id: 'pricing', label: 'Pricing' },
  { id: 'docs', label: 'API Docs' },
  { id: 'stats', label: 'Network' },
  { id: 'staking', label: 'Staking' },
]

export type PageId = 'pricing' | 'docs' | 'stats' | 'staking'

function Btn({ children, href, kind = 'cyan', onClick }: { children: ReactNode; href?: string; kind?: 'cyan' | 'ghost'; onClick?: () => void }) {
  const base: CSSProperties = {
    fontFamily: 'var(--mono)',
    fontSize: 12,
    letterSpacing: '.04em',
    padding: '10px 16px',
    borderRadius: 9,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    transition: 'filter .2s, border-color .2s, background .2s',
    ...(kind === 'cyan'
      ? { background: ACCENT, color: '#06080b', border: `1px solid ${ACCENT}` }
      : { background: 'transparent', color: INK, border: '1px solid rgba(140,158,176,.32)' }),
  }
  if (href) return <a href={href} className={`btn-${kind}`} style={base}>{children}</a>
  return <button className={`btn-${kind}`} onClick={onClick} style={{ ...base, font: base.font }}>{children}</button>
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400) })}
      className="btn-ghost"
      style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.04em', padding: '6px 11px', borderRadius: 8, cursor: 'pointer', color: INK, background: 'transparent', border: '1px solid rgba(140,158,176,.3)' }}
    >
      {done ? '✓ Copied' : 'Copy'}
    </button>
  )
}

function Code({ children, title }: { children: string; title?: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ ...LABEL, fontSize: 10 }}>{title}</span>
          <Copy text={children} />
        </div>
      )}
      <pre
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 12.5,
          lineHeight: 1.7,
          color: '#cdd9e4',
          background: 'rgba(6,9,12,.85)',
          border: '1px solid rgba(140,158,176,.16)',
          borderRadius: 10,
          padding: 16,
          margin: 0,
          overflowX: 'auto',
        }}
      >
        {children}
      </pre>
    </div>
  )
}

function Pill({ children, color = ACCENT }: { children: ReactNode; color?: string }) {
  return (
    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color, border: `1px solid ${color}55`, background: `${color}12`, borderRadius: 6, padding: '2px 8px', letterSpacing: '.04em' }}>
      {children}
    </span>
  )
}

/* ---------------- shared header + footer ---------------- */
function SiteHeader({ page }: { page: PageId }) {
  return (
    <header
      style={{
        position: 'sticky', top: 0, zIndex: 30,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 5vw',
        background: 'rgba(7,11,16,.82)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(140,158,176,.14)',
      }}
    >
      <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none' }}>
        <img src="/logo.png" alt="" width={30} height={30} style={{ borderRadius: 8, border: '1px solid rgba(140,158,176,.3)' }} />
        <span style={{ fontFamily: 'var(--display)', fontWeight: 500, letterSpacing: '.16em', fontSize: 14, color: INK }}>GPUGRID</span>
      </a>
      <nav style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#/${n.id}`}
            style={{
              fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '.04em', padding: '8px 12px', borderRadius: 8,
              textDecoration: 'none', color: page === n.id ? '#06080b' : SUB, background: page === n.id ? ACCENT : 'transparent',
            }}
          >
            {n.label}
          </a>
        ))}
        <a href="#/app" className="link-dim" style={{ fontFamily: 'var(--mono)', fontSize: 12, color: DIM, textDecoration: 'none', marginLeft: 8 }}>Console →</a>
      </nav>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer style={{ position: 'relative', zIndex: 1, borderTop: '1px solid rgba(140,158,176,.12)', padding: '28px 5vw', textAlign: 'center' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: DIM, letterSpacing: '.08em' }}>
        GpuGrid · decentralized GPU network · <a href="#/" className="link-dim" style={{ color: DIM }}>gpugrid.app</a>
      </span>
    </footer>
  )
}

function PageGlow() {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0,
        background: 'radial-gradient(120% 60% at 50% 0%, rgba(95,212,226,.10) 0%, transparent 55%)',
      }}
    />
  )
}

/* ---------------- shared shell (centered - pricing / stats) ---------------- */
function PageShell({ page, children }: { page: PageId; children: ReactNode }) {
  return (
    <div className="console-enter" style={{ minHeight: '100vh', background: '#070b10', position: 'relative' }}>
      <PageGlow />
      <SiteHeader page={page} />
      <main style={{ position: 'relative', zIndex: 1, maxWidth: 1180, margin: '0 auto', padding: '48px 5vw 100px' }}>
        {children}
      </main>
      <SiteFooter />
    </div>
  )
}

/* ---------------- pricing ---------------- */
// $ per 1,000,000 tokens (price is stored as credits/1M, 1 credit = 1 micro-USD).
const per1M = (credits: number) => `$${(credits / 1_000_000).toFixed(2)}`

/* ---------------- GPU catalog (vast.ai-style cards) ----------------
   We price per token, not per hour - so each card shows the effective
   $/1M-token rate for that GPU class (base model price × the class factor),
   with live availability from /api/nodes. `match` maps a card to live nodes. */
type Gpu = { name: string; arch: string; vram: string; tier: string; factor: number; match: string }
const GPU_CATALOG: Gpu[] = [
  // datacenter flagships
  { name: 'H100 SXM', arch: 'Hopper', vram: '80 GB', tier: 'Flagship', factor: 1.4, match: 'h100 sxm' },
  { name: 'H100 NVL', arch: 'Hopper', vram: '94 GB', tier: 'Flagship', factor: 1.35, match: 'h100 nvl' },
  { name: 'A100 80GB', arch: 'Ampere', vram: '80 GB', tier: 'Flagship', factor: 1.2, match: 'a100' },
  { name: 'L40S', arch: 'Ada Lovelace', vram: '48 GB', tier: 'Flagship', factor: 1.05, match: 'l40' },
  // consumer flagships
  { name: 'RTX 5090', arch: 'Blackwell', vram: '32 GB', tier: 'Consumer', factor: 0.9, match: '5090' },
  { name: 'RTX 4090', arch: 'Ada Lovelace', vram: '24 GB', tier: 'Consumer', factor: 0.85, match: '4090' },
  { name: 'RTX 4080', arch: 'Ada Lovelace', vram: '16 GB', tier: 'Consumer', factor: 0.7, match: '4080' },
  { name: 'RTX 3090', arch: 'Ampere', vram: '24 GB', tier: 'Consumer', factor: 0.65, match: '3090' },
  { name: 'RTX 4070 Ti', arch: 'Ada Lovelace', vram: '12 GB', tier: 'Consumer', factor: 0.6, match: '4070' },
  { name: 'RTX 3060', arch: 'Ampere', vram: '12 GB', tier: 'Consumer', factor: 0.5, match: '3060' },
  // apple silicon
  { name: 'Apple M3 Max', arch: 'Apple Silicon', vram: 'Unified', tier: 'Apple Silicon', factor: 0.75, match: 'm3 max' },
  { name: 'Apple M2 Max', arch: 'Apple Silicon', vram: 'Unified', tier: 'Apple Silicon', factor: 0.7, match: 'm2 max' },
  { name: 'Apple M1 Max', arch: 'Apple Silicon', vram: 'Unified', tier: 'Apple Silicon', factor: 0.6, match: 'm1 max' },
]
const GPU_TIER_ORDER = ['Flagship', 'Consumer', 'Apple Silicon']

// Deterministic sparkline (stable per GPU name) - ambient activity, not a data feed.
function sparkPath(seed: string, w: number, h: number, n = 22): string {
  let s = 0
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  let v = 0.5
  const pts: string[] = []
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    const r = s / 2 ** 32 - 0.5
    v = Math.max(0.18, Math.min(0.82, v + r * 0.16))
    pts.push(`${((i / (n - 1)) * w).toFixed(1)},${(h - v * h).toFixed(1)}`)
  }
  return pts.join(' ')
}
function Sparkline({ seed, color }: { seed: string; color: string }) {
  const W = 300, H = 40
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block', margin: '4px 0 2px' }} aria-hidden>
      <polyline points={sparkPath(seed, W, H)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.9} />
    </svg>
  )
}

// Availability indicator: 3 dots + Low/Med/High from the live online count.
function Avail({ online }: { online: number }) {
  const level = online >= 6 ? 3 : online >= 3 ? 2 : online >= 1 ? 1 : 0
  const label = ['Off-grid', 'Low', 'Med', 'High'][level]
  const col = level === 0 ? DIM : level >= 3 ? '#57d38a' : level === 2 ? ACCENT : CORE
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: 14, height: 6, borderRadius: 2, background: i < level ? col : 'rgba(140,158,176,.22)' }} />
        ))}
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: level === 0 ? DIM : INK, border: '1px solid rgba(140,158,176,.24)', borderRadius: 6, padding: '2px 7px' }}>
        {label}
      </span>
    </div>
  )
}

function GpuCard({ g, base, online }: { g: Gpu; base: number; online: number }) {
  const on = online > 0
  const price = base * g.factor // $ per 1M output tokens on this GPU class
  const accent = on ? ACCENT : CORE
  return (
    <div className="gpu-card" style={{ ...PANEL, padding: 18, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ fontFamily: 'var(--display)', fontSize: 19, color: INK, letterSpacing: '.01em' }}>{g.name}</div>
        <Avail online={online} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: SUB, background: 'rgba(140,158,176,.12)', borderRadius: 6, padding: '3px 8px', letterSpacing: '.03em' }}>{g.arch}</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: DIM }}>{g.vram} VRAM</span>
      </div>
      <Sparkline seed={g.name} color={accent} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 8 }}>
        <div>
          <span style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, color: INK }}>${price.toFixed(2)}</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: DIM, marginLeft: 6 }}>/1M tok</span>
        </div>
        <Btn href="#/app" kind={on ? 'cyan' : 'ghost'} >{on ? 'Use →' : 'Details'}</Btn>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: DIM, marginTop: 8 }}>
        {on ? `${online} online now` : 'not currently on the grid'} · ${(price * 0.85).toFixed(2)} - ${(price * 1.15).toFixed(2)} range
      </div>
    </div>
  )
}

function GpuCatalog({ data, nodes }: { data: PricingData | null; nodes: GpuNode[] }) {
  // base = $ per 1M output tokens for llama3:8b (our reference model)
  const baseCredits = data?.models.find((m) => m.model === 'llama3:8b')?.out ?? data?.defaultPrice.out ?? 0
  const base = baseCredits / 1_000_000
  const onlineFor = (g: Gpu) => nodes.filter((n) => n.online && n.gpu.toLowerCase().includes(g.match)).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {GPU_TIER_ORDER.map((tier) => {
        const gpus = GPU_CATALOG.filter((g) => g.tier === tier)
        return (
          <div key={tier}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <h2 style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: 22, color: INK, margin: 0 }}>{tier}</h2>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: SUB, background: 'rgba(140,158,176,.12)', borderRadius: 6, padding: '3px 8px' }}>
                {gpus.length} GPUs
              </span>
            </div>
            <div className="gpu-grid">
              {gpus.map((g) => <GpuCard key={g.name} g={g} base={base} online={onlineFor(g)} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Pricing() {
  const [data, setData] = useState<PricingData | null>(null)
  const [nodes, setNodes] = useState<GpuNode[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    api.pricing().then(setData).catch((e) => setErr(e instanceof Error ? e.message : 'failed to load pricing'))
    api.nodes().then((r) => setNodes(r.nodes)).catch(() => {})
  }, [])

  const free = data?.free
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      <div>
        <div style={LABEL}>GPU PRICING</div>
        <h1 style={{ ...H2, fontSize: 40, marginTop: 10 }}>Inference on any GPU, priced per token</h1>
        <p style={LEAD}>
          No hourly rental, no idle bills - you pay per token, at a fraction of hosted-API prices. Each card shows the
          effective <b style={{ color: INK }}>$/1M-token</b> rate for that GPU class and its live availability on the grid.
        </p>
      </div>

      {/* vast.ai-style GPU catalogue */}
      <GpuCatalog data={data} nodes={nodes} />

      {/* free plan */}
      <div style={{ ...PANEL, borderColor: 'rgba(95,212,226,.4)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <div style={{ ...LABEL, color: ACCENT }}>FREE PLAN</div>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 34, color: INK, marginTop: 8 }}>
              {free
                ? free.signupFreeRequests
                  ? `${free.signupFreeRequests} free requests`
                  : `$${free.signupBonusUsd.toFixed(0)} free credits`
                : '-'}
            </div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 14, color: SUB, marginTop: 2 }}>
              on signup - no card required{free?.playgroundPerIpPerDay ? ` · plus ${free.playgroundPerIpPerDay}/day in the playground, no account at all` : ''}
            </div>
          </div>
          <Btn href="#/app">Start free → get API key</Btn>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 12, marginTop: 20 }}>
          {[
            ['Community GPUs', free?.communityGpusOnly ? 'Included - the grid’s shared nodes' : 'Included'],
            ['Playground (no signup)', free?.playgroundPerIpPerDay ? `${free.playgroundPerIpPerDay} requests / day · ${free.playgroundModel ?? 'llama3:8b'}` : '-'],
            ['Rate limit', free ? `${free.rateLimitPerMin} requests / min` : '-'],
            ['Max output', free?.signupFreeRequests ? `${(free.freeMaxOutputTokens ?? 400).toLocaleString('en-US')} tokens / free request` : free ? `${free.maxOutputTokens.toLocaleString('en-US')} tokens / request` : '-'],
            ['Signups per network', free ? `${free.signupsPerIpPerDay} / day per IP` : '-'],
            ['Cloud fallback (paid GPUs)', 'Unlocked once you top up'],
            ['Billing', 'Metered per token - pay as you go'],
          ].map(([k, v]) => (
            <div key={k} style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.14)' }}>
              <div style={{ ...LABEL, fontSize: 10, marginBottom: 6 }}>{k.toUpperCase()}</div>
              <div style={{ fontFamily: 'var(--display)', fontSize: 14.5, color: INK }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* per-model price table */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 4 }}>PER-MODEL PRICE</div>
        <p style={{ fontFamily: 'var(--display)', fontSize: 14, color: SUB, margin: '0 0 16px' }}>
          Per 1,000,000 tokens. You pay the price of the node your request lands on - cheaper nodes cost you less.
        </p>
        {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#f0a892' }}>{err}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 13 }}>
            <thead>
              <tr style={{ color: DIM, textAlign: 'left' }}>
                {['MODEL', 'INPUT / 1M', 'OUTPUT / 1M'].map((h) => (
                  <th key={h} style={{ padding: '8px 12px 12px', fontWeight: 400, letterSpacing: '.08em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.models.map((m) => (
                <tr key={m.model} style={{ borderTop: '1px solid rgba(140,158,176,.1)', color: '#bccadb' }}>
                  <td style={{ padding: '11px 12px', color: INK }}>{m.model}</td>
                  <td style={{ padding: '11px 12px', color: ACCENT }}>{per1M(m.in)}</td>
                  <td style={{ padding: '11px 12px', color: ACCENT }}>{per1M(m.out)}</td>
                </tr>
              ))}
              {data && (
                <tr style={{ borderTop: '1px solid rgba(140,158,176,.1)', color: DIM }}>
                  <td style={{ padding: '11px 12px' }}>any other model</td>
                  <td style={{ padding: '11px 12px' }}>{per1M(data.defaultPrice.in)}</td>
                  <td style={{ padding: '11px 12px' }}>{per1M(data.defaultPrice.out)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* where the money goes */}
      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 14 }}>WHERE EVERY PAYMENT GOES</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
          {[
            ['75%', 'GPU provider', ACCENT],
            ['20%', 'Stakers', ACCENT],
            ['5%', 'Treasury', CORE],
          ].map(([pct, who, col]) => (
            <div key={who} style={{ padding: '16px 14px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.14)' }}>
              <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 28, color: col }}>{pct}</div>
              <div style={{ ...LABEL, fontSize: 10, marginTop: 4 }}>{who.toUpperCase()}</div>
            </div>
          ))}
        </div>
        <p style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: SUB, margin: '16px 0 0', lineHeight: 1.6 }}>
          Enforced on-chain by the <code style={{ fontFamily: 'var(--mono)', color: ACCENT }}>ggrid_payout</code> contract - the
          split is code, not a promise. Providers withdraw their share as $GGRID at any time.
        </p>
      </div>
    </div>
  )
}

/* ---------------- network stats ---------------- */
function StatTile({ label, value, color = INK }: { label: string; value: ReactNode; color?: string }) {
  return (
    <div style={PANEL}>
      <div style={LABEL}>{label}</div>
      <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 40, color, marginTop: 8, lineHeight: 1 }}>{value}</div>
    </div>
  )
}

function Stats() {
  const [s, setS] = useState<Stats | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    api.stats().then(setS).catch((e) => setErr(e instanceof Error ? e.message : 'failed to load stats'))
  }, [])
  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={LABEL}>NETWORK</div>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3fd07e', boxShadow: '0 0 8px rgba(63,208,126,.9)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: DIM, letterSpacing: '.1em' }}>LIVE · refreshes every 10s</span>
        </div>
        <h1 style={{ ...H2, fontSize: 40, marginTop: 10 }}>The grid right now</h1>
        <p style={LEAD}>Live capacity and throughput across every community and cloud node serving the network.</p>
      </div>

      {err && <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#f0a892' }}>{err}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16 }}>
        <StatTile label="NODES ONLINE" value={s ? s.onlineNodes : '-'} color={ACCENT} />
        <StatTile label="MODELS SERVED" value={s ? s.models.length : '-'} />
        <StatTile label="DEVELOPERS" value={s ? compact(s.users) : '-'} />
        <StatTile label="JOBS COMPLETED" value={s ? compact(s.totalJobs) : '-'} />
        <StatTile label="TOKENS PROCESSED" value={s ? compact(s.totalTokens) : '-'} color={CORE} />
      </div>

      <div style={PANEL}>
        <div style={{ ...LABEL, marginBottom: 14 }}>MODELS AVAILABLE NOW</div>
        {!s || s.models.length === 0 ? (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: DIM }}>No models online right now - check back shortly.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {s.models.map((m) => <Pill key={m}>{m}</Pill>)}
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------- API docs ---------------- */
function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} style={{ scrollMarginTop: 100 }}>
      <h2 style={{ fontFamily: 'var(--display)', fontWeight: 400, fontSize: 22, color: INK, margin: '0 0 12px', letterSpacing: '.01em' }}>{title}</h2>
      {children}
    </section>
  )
}
const P = ({ children, style }: { children: ReactNode; style?: CSSProperties }) => (
  <p style={{ fontFamily: 'var(--display)', fontSize: 15, color: SUB, lineHeight: 1.65, margin: '0 0 12px', ...style }}>{children}</p>
)
const MonoInline = ({ children }: { children: ReactNode }) => (
  <code style={{ fontFamily: 'var(--mono)', fontSize: 13, color: ACCENT, background: 'rgba(95,212,226,.08)', padding: '1px 6px', borderRadius: 5 }}>{children}</code>
)
function Endpoint({ method, path }: { method: string; path: string }) {
  const col = method === 'GET' ? ACCENT : CORE
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 8px' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, color: '#06080b', background: col, padding: '3px 8px', borderRadius: 6 }}>{method}</span>
      <code style={{ fontFamily: 'var(--mono)', fontSize: 13.5, color: INK }}>{path}</code>
    </div>
  )
}

/* grouped left-nav + flat right "on this page" share these sections */
const DOC_GROUPS: { group: string; items: [string, string][] }[] = [
  { group: 'Get started', items: [['intro', 'Introduction'], ['auth', 'Authentication']] },
  { group: 'Core API', items: [['chat', 'Chat completions'], ['stream', 'Streaming'], ['embeddings', 'Embeddings'], ['models', 'List models'], ['catalog', 'Models & pricing']] },
  { group: 'Account', items: [['account', 'Account & credits'], ['topup', 'Top up with $GGRID']] },
  { group: 'Token', items: [['token', '$GGRID token']] },
  { group: 'Providers', items: [['guide', 'Run a GPU node'], ['provider', 'Provider API']] },
  { group: 'Reference', items: [['errors', 'Errors & limits']] },
]
const DOC_TOC: [string, string][] = DOC_GROUPS.flatMap((g) => g.items)

// Scroll-spy: the last section whose top has passed under the sticky header.
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0] ?? '')
  useEffect(() => {
    const onScroll = () => {
      let current = ids[0] ?? ''
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top - 100 <= 0) current = id
      }
      setActive(current)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join('|')])
  return active
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

/* left sidebar - grouped nav + search (RunPod-style) */
function DocsSidebar({ active }: { active: string }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  return (
    <aside className="docs-side">
      <div style={{ position: 'relative', marginBottom: 22 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search docs…"
          style={{
            width: '100%', fontFamily: 'var(--mono)', fontSize: 12.5, color: INK,
            background: 'rgba(6,9,12,.7)', border: '1px solid rgba(140,158,176,.2)', borderRadius: 9, padding: '9px 12px',
          }}
        />
      </div>
      {DOC_GROUPS.map((g) => {
        const items = g.items.filter(([, label]) => !ql || label.toLowerCase().includes(ql))
        if (!items.length) return null
        return (
          <div key={g.group} style={{ marginBottom: 20 }}>
            <div style={{ ...LABEL, fontSize: 10.5, color: DIM, marginBottom: 8 }}>{g.group.toUpperCase()}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {items.map(([id, label]) => {
                const on = id === active
                return (
                  <a
                    key={id}
                    href="#/docs"
                    onClick={(e) => { e.preventDefault(); scrollToSection(id) }}
                    className="docs-navlink"
                    style={{
                      fontFamily: 'var(--display)', fontSize: 14, textDecoration: 'none', padding: '6px 12px',
                      borderRadius: 8, borderLeft: `2px solid ${on ? ACCENT : 'transparent'}`,
                      color: on ? ACCENT : SUB, background: on ? 'rgba(95,212,226,.08)' : 'transparent',
                    }}
                  >
                    {label}
                  </a>
                )
              })}
            </div>
          </div>
        )
      })}
    </aside>
  )
}

/* right rail - "on this page" scroll-spy */
function DocsToc({ active }: { active: string }) {
  return (
    <aside className="docs-toc">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...LABEL, fontSize: 10.5, color: DIM, marginBottom: 14 }}>
        <span style={{ width: 12, height: 1.5, background: DIM, display: 'inline-block' }} /> ON THIS PAGE
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {DOC_TOC.map(([id, label]) => {
          const on = id === active
          return (
            <a
              key={id}
              href="#/docs"
              onClick={(e) => { e.preventDefault(); scrollToSection(id) }}
              style={{
                fontFamily: 'var(--display)', fontSize: 13, textDecoration: 'none', padding: '4px 0 4px 13px',
                borderLeft: `2px solid ${on ? ACCENT : 'rgba(140,158,176,.16)'}`, color: on ? INK : DIM, transition: 'color .2s',
              }}
            >
              {label}
            </a>
          )
        })}
      </div>
    </aside>
  )
}

/* center content - title + all doc sections */
/* $GGRID token facts. Supply and the renounced authorities are read LIVE from chain
   (the burn cut shrinks supply on every job), so nothing here is a stale constant.
   When the gateway has no RPC configured we show the immutable facts only and say
   the live figures are unavailable rather than inventing them. */
const num = (n: number | undefined, dp = 0) =>
  n === undefined ? '-' : n.toLocaleString('en-US', { maximumFractionDigits: dp })

function TokenFacts() {
  const [t, setT] = useState<TokenInfo | null>(null)
  useEffect(() => {
    api.token().then(setT).catch(() => setT({ available: false }))
  }, [])

  const live = t?.available === true
  const explorer = t?.mint ? `https://solscan.io/token/${t.mint}` : undefined

  const rows: [string, ReactNode][] = [
    ['Name', 'GpuGrid'],
    ['Symbol', <MonoInline key="s">$GGRID</MonoInline>],
    ['Network', 'Solana'],
    ['Standard', t?.tokenProgram === 'token2022' ? 'Token-2022' : 'SPL Token'],
    ['Decimals', live ? String(t!.decimals) : '6'],
    [
      'Mint address',
      t?.mint ? (
        <a href={explorer} target="_blank" rel="noopener noreferrer" style={{ color: ACCENT, fontFamily: 'var(--mono)', fontSize: 12.5, wordBreak: 'break-all' }}>
          {t.mint}
        </a>
      ) : (
        <span style={{ color: DIM }}>unavailable</span>
      ),
    ],
  ]

  return (
    <>
      <P>
        <b style={{ color: INK }}>$GGRID</b> is the payment and reward asset of the network. Developers spend it on
        inference, GPU providers earn it, and stakers share the protocol fee. It is a fixed-supply token: the mint
        authority is renounced, so no new $GGRID can ever be created. A portion was <b style={{ color: INK }}>burned</b>
        {' '}earlier in the network's life, permanently reducing supply below the initial mint.
      </P>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 12, margin: '18px 0' }}>
        {[
          ['Total supply', live ? `${num(t!.supply, 2)}` : '-', 'circulating, live from chain'],
          ['Initial supply', live ? num(t!.initialSupply) : '1,000,000,000', 'minted once, at launch'],
          ['Burned to date', live ? num(t!.burned, 2) : '-', 'permanently removed from supply'],
        ].map(([k, v, sub]) => (
          <div key={k} style={{ padding: '16px 14px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.14)' }}>
            <div style={{ ...LABEL, fontSize: 10 }}>{String(k).toUpperCase()}</div>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 25, color: k === 'Burned to date' ? CORE : ACCENT, margin: '6px 0 4px' }}>{v}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: DIM }}>{sub}</div>
          </div>
        ))}
      </div>

      {!live && (
        <P>
          <span style={{ color: CORE }}>Live supply is temporarily unavailable</span> - read it straight from the chain with{' '}
          <MonoInline>getTokenSupply</MonoInline>, or check the explorer.
        </P>
      )}

      <div style={{ overflowX: 'auto', margin: '4px 0 18px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--display)', fontSize: 14 }}>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} style={{ borderTop: '1px solid rgba(140,158,176,.1)' }}>
                <td style={{ padding: '11px 12px 11px 0', color: DIM, whiteSpace: 'nowrap', width: 150 }}>{k}</td>
                <td style={{ padding: '11px 0', color: INK }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12, marginBottom: 18 }}>
        {[
          ['Mint authority', live ? (t!.mintAuthorityRenounced ? 'Renounced' : 'Active') : 'Renounced', 'No one can mint more $GGRID'],
          ['Freeze authority', live ? (t!.freezeAuthorityRenounced ? 'Renounced' : 'Active') : 'Renounced', 'No one can freeze your tokens'],
        ].map(([k, v, sub]) => {
          const good = v === 'Renounced'
          return (
            <div key={k} style={{ padding: '14px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: `1px solid ${good ? 'rgba(95,212,226,.28)' : 'rgba(230,164,75,.35)'}` }}>
              <div style={{ ...LABEL, fontSize: 10 }}>{String(k).toUpperCase()}</div>
              <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 18, color: good ? ACCENT : CORE, margin: '5px 0 3px' }}>{v}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: DIM }}>{sub}</div>
            </div>
          )
        })}
      </div>

      <P>
        <b style={{ color: INK }}>Utility.</b> Developers deposit $GGRID to buy inference credits. Every job is settled
        on-chain by the <MonoInline>ggrid_payout</MonoInline> contract, which splits the payment{' '}
        <MonoInline>75% provider · 20% stakers · 5% treasury</MonoInline> - code, not a promise. Staking
        $GGRID earns you a proportional share of that 20% cut.
      </P>
      <P>
        <b style={{ color: INK }}>Supply is deflationary by design.</b> There is no emission and no inflation. The only
        force acting on supply is the burn, so the total can only shrink as the network is used.
      </P>
    </>
  )
}

function DocsContent() {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://gpugrid.app'
  return (
    <div style={{ maxWidth: 760 }}>
      {/* mobile-only quick nav (side rails hidden on narrow screens) */}
      <div className="docs-mobile-nav">
        {DOC_TOC.map(([id, label]) => (
          <a key={id} href="#/docs" onClick={(e) => { e.preventDefault(); scrollToSection(id) }}
             style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: SUB, textDecoration: 'none', border: '1px solid rgba(140,158,176,.2)', borderRadius: 7, padding: '5px 10px', whiteSpace: 'nowrap' }}>
            {label}
          </a>
        ))}
      </div>

      <div style={{ marginBottom: 30 }}>
        <div style={LABEL}>API REFERENCE</div>
        <h1 style={{ ...H2, fontSize: 40, marginTop: 10 }}>GpuGrid API</h1>
        <p style={LEAD}>
          An <b style={{ color: INK }}>OpenAI-compatible</b> gateway. Point any OpenAI SDK or tool at the grid - change only the
          base URL and key. Base URL <MonoInline>{origin}/v1</MonoInline>.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 34 }}>
        <DocSection id="intro" title="Introduction">
          <P>
            GpuGrid routes your inference across a decentralized network of GPUs. The API mirrors the OpenAI REST API, so
            existing clients work unchanged. Requests are metered per token; new accounts get free trial credits.
          </P>
          <P>Three steps: create an account for a key, point your client at <MonoInline>{origin}/v1</MonoInline>, send requests.</P>
        </DocSection>

        <DocSection id="auth" title="Authentication">
          <P>Authenticate with your API key as a bearer token. Keys start with <MonoInline>ggrid_sk_</MonoInline>. Create one from the <a href="#/app" style={{ color: ACCENT }}>console</a> or via the API below.</P>
          <Code title="HEADER">{`Authorization: Bearer ggrid_sk_your_key_here`}</Code>
        </DocSection>

        <DocSection id="chat" title="Chat completions">
          <Endpoint method="POST" path="/v1/chat/completions" />
          <P>OpenAI-compatible. Body accepts <MonoInline>model</MonoInline>, <MonoInline>messages</MonoInline>, and the usual options (<MonoInline>temperature</MonoInline>, <MonoInline>max_tokens</MonoInline>, <MonoInline>stream</MonoInline>). Output is capped per request (see limits).</P>
          <Code title="CURL">{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ggrid_sk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "llama3:8b",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`}</Code>
          <Code title="PYTHON (openai SDK)">{`from openai import OpenAI

client = OpenAI(base_url="${origin}/v1", api_key="ggrid_sk_...")
r = client.chat.completions.create(
    model="llama3:8b",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(r.choices[0].message.content)`}</Code>
          <Code title="NODE (openai SDK)">{`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${origin}/v1", apiKey: "ggrid_sk_..." });
const r = await client.chat.completions.create({
  model: "llama3:8b",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(r.choices[0].message.content);`}</Code>
        </DocSection>

        <DocSection id="stream" title="Streaming">
          <P>Set <MonoInline>stream: true</MonoInline> to receive Server-Sent Events, exactly like OpenAI. Token usage is included in the final chunk.</P>
          <Code title="CURL">{`curl ${origin}/v1/chat/completions \\
  -H "Authorization: Bearer ggrid_sk_..." \\
  -d '{"model":"llama3:8b","stream":true,
       "messages":[{"role":"user","content":"Count to 5"}]}'`}</Code>
        </DocSection>

        <DocSection id="embeddings" title="Embeddings">
          <Endpoint method="POST" path="/v1/embeddings" />
          <P>Billed like chat, per token.</P>
          <Code title="CURL">{`curl ${origin}/v1/embeddings \\
  -H "Authorization: Bearer ggrid_sk_..." \\
  -d '{"model":"nomic-embed-text","input":"the quick brown fox"}'`}</Code>
        </DocSection>

        <DocSection id="models" title="List models">
          <Endpoint method="GET" path="/v1/models" />
          <P>Returns the models currently served by the grid, plus the known catalog.</P>
          <Code title="CURL">{`curl ${origin}/v1/models -H "Authorization: Bearer ggrid_sk_..."`}</Code>
        </DocSection>

        <DocSection id="catalog" title="Models & pricing">
          <P>
            The grid is <b style={{ color: INK }}>model-agnostic</b>. There is no fixed allow-list: it serves whatever a
            provider has pulled in <MonoInline>ollama</MonoInline>, so the live set grows as the network grows. Ask for a
            model by its Ollama name (for example <MonoInline>llama3.1:8b</MonoInline> or <MonoInline>qwen2.5:7b</MonoInline>)
            and the router sends your request to the cheapest live GPU serving it.
          </P>

          <div style={{ margin: '4px 0 6px', padding: '13px 15px', borderRadius: 10, background: 'rgba(95,212,226,.06)', border: '1px solid rgba(95,212,226,.28)' }}>
            <div style={{ ...LABEL, fontSize: 10, color: ACCENT, marginBottom: 5 }}>ANY MODEL WORKS</div>
            <div style={{ fontFamily: 'var(--display)', fontSize: 14.5, color: '#cdd9e4', lineHeight: 1.55 }}>
              Models below have a published price. <b style={{ color: INK }}>Any other model a provider serves also works</b> - it is
              simply billed at the flat default rate until it is added to the price sheet. Call <MonoInline>GET /v1/models</MonoInline>{' '}
              to see exactly what is online right now.
            </div>
          </div>

          <P>Published rates, per 1,000,000 tokens (1 credit = 1 micro-USD):</P>
          <div style={{ overflowX: 'auto', margin: '2px 0 16px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--display)', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(140,158,176,.2)' }}>
                  {['Model', 'Class', 'Input / 1M', 'Output / 1M'].map((h, i) => (
                    <th key={h} style={{ ...LABEL, fontSize: 10, textAlign: i > 1 ? 'right' : 'left', padding: '0 10px 9px 0', color: DIM }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ['llama3:8b', '8B', '$0.05', '$0.15'],
                  ['llama3.1:8b', '8B', '$0.05', '$0.15'],
                  ['qwen2.5:7b', '7B', '$0.05', '$0.15'],
                  ['mistral:7b', '7B', '$0.05', '$0.15'],
                  ['gemma2:9b', '9B', '$0.06', '$0.18'],
                  ['llama3:70b', '70B', '$0.30', '$0.90'],
                  ['any other model', 'default', '$0.10', '$0.30'],
                ] as [string, string, string, string][]).map(([m, cls, inp, out]) => {
                  const fallback = cls === 'default'
                  return (
                    <tr key={m} style={{ borderTop: '1px solid rgba(140,158,176,.1)' }}>
                      <td style={{ padding: '10px 10px 10px 0' }}>
                        <MonoInline>{m}</MonoInline>
                      </td>
                      <td style={{ padding: '10px 10px 10px 0', color: fallback ? CORE : DIM }}>{cls}</td>
                      <td style={{ padding: '10px 0', color: INK, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{inp}</td>
                      <td style={{ padding: '10px 0', color: INK, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{out}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <P>
            <b style={{ color: INK }}>Embeddings too.</b> Embedding models (such as <MonoInline>nomic-embed-text</MonoInline>) run
            through <MonoInline>/v1/embeddings</MonoInline> on nodes that advertise that capability, billed per token the same way.
          </P>
          <P>
            <b style={{ color: INK }}>Pick a specific GPU.</b> Send an <MonoInline>x-ggrid-node</MonoInline> header with a node id
            to pin your request to one exact machine instead of the auto-router - the GPU-marketplace mode. Browse available nodes
            with <MonoInline>GET /api/nodes</MonoInline>.
          </P>
          <P style={{ color: DIM, fontSize: 13.5 }}>
            If no online node serves the model you ask for, the request returns <MonoInline>404</MonoInline> (or spins up a cloud GPU
            when cloud fallback is enabled for your account). Full per-model prices also live on the{' '}
            <a href="#/pricing" style={{ color: ACCENT }}>Pricing</a> page.
          </P>
        </DocSection>

        <DocSection id="account" title="Account & credits">
          <P>Create an account (returns a key + free credits), check your balance and usage, and manage keys.</P>
          <Endpoint method="POST" path="/api/signup" />
          <Endpoint method="GET" path="/api/me" />
          <Endpoint method="GET" path="/api/usage" />
          <Endpoint method="GET" path="/api/keys" />
          <Endpoint method="POST" path="/api/keys" />
          <Endpoint method="DELETE" path="/api/keys/:id" />
          <Code title="CURL - new account">{`curl ${origin}/api/signup -d '{}'
# → { "userId": "...", "apiKey": "ggrid_sk_...", "balance": 5000000 }`}</Code>
        </DocSection>

        <DocSection id="topup" title="Top up with $GGRID">
          <P>Buy credits by depositing <b style={{ color: INK }}>$GGRID</b> into the on-chain vault. Non-custodial: the deposit goes to the contract, not to us, and funds provider payouts directly. The console handles the wallet flow; the API is:</P>
          <Endpoint method="POST" path="/api/credits/intent" />
          <Endpoint method="GET" path="/api/credits/status" />
          <P><MonoInline>intent</MonoInline> returns an unsigned deposit transaction + a reference; your wallet signs and sends it; poll <MonoInline>status</MonoInline> until <MonoInline>CONFIRMED</MonoInline> and the credits land on your balance.</P>
        </DocSection>

        <DocSection id="token" title="$GGRID token">
          <TokenFacts />
          <P>The same figures are available programmatically:</P>
          <Endpoint method="GET" path="/api/token" />
          <Code title="CURL">{`curl ${origin}/api/token`}</Code>
        </DocSection>

        <DocSection id="guide" title="Run a GPU node (become a provider)">
          <P>
            Rent out an idle GPU to the grid and earn <b style={{ color: INK }}>75% of every job</b> it serves, paid in
            $GGRID. This is the full walkthrough - the one-line installer does steps 2-4 for you.
          </P>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 10, margin: '4px 0 16px' }}>
            {[
              ['Requirements', 'NVIDIA GPU with 8 GB+ VRAM (Windows), or an Apple Silicon Mac - M4 / M5 (macOS).'],
              ['Installed for you', 'Ollama + a secure Cloudflare tunnel - no account, no port-forwarding.'],
              ['Payout', 'Add a Solana wallet; withdraw $GGRID on-chain anytime.'],
            ].map(([k, v]) => (
              <div key={k} style={{ padding: '12px 14px', borderRadius: 10, background: 'rgba(6,9,12,.55)', border: '1px solid rgba(140,158,176,.14)' }}>
                <div style={{ ...LABEL, fontSize: 10, color: CORE, marginBottom: 6 }}>{k.toUpperCase()}</div>
                <div style={{ fontFamily: 'var(--display)', fontSize: 13.5, color: '#cdd9e4', lineHeight: 1.5 }}>{v}</div>
              </div>
            ))}
          </div>
          <P><b style={{ color: INK }}>1. Get a provider token</b> - open the <a href="#/providers" style={{ color: CORE }}>Providers console</a> and click “Register a provider node”, or:</P>
          <Code title="CURL">{`curl ${origin}/api/providers -d '{}'
# → { "providerId": "...", "providerToken": "ggrid_pv_..." }`}</Code>
          <P><b style={{ color: INK }}>2. Run the installer</b> on the GPU machine. It installs Ollama, pulls a model, opens a tunnel, and registers the node:</P>
          <Code title="WINDOWS (PowerShell)">{`$env:PROVIDER_TOKEN="ggrid_pv_..."; irm ${origin}/install.ps1 | iex`}</Code>
          <Code title="MACOS - APPLE SILICON (M4 / M5)">{`curl -fsSL ${origin}/install.sh | PROVIDER_TOKEN=ggrid_pv_... bash`}</Code>
          <P style={{ color: DIM, fontSize: 13 }}>
            Apple Silicon nodes are hardware-verified on connect (M4 / M5 only - older chips are declined). A MacBook Air
            works but throttles under long sustained jobs, so it's flagged for short bursts; a Mac with active cooling
            (Pro / mini / Studio) stays at full speed and earns more.
          </P>
          <P><b style={{ color: INK }}>3. Stay online</b> - keep the window open. Your node shows as <MonoInline>online</MonoInline> in the console and the grid routes jobs to it automatically. The more reliable your uptime, the more traffic you get.</P>
          <P><b style={{ color: INK }}>4. Add a wallet & withdraw</b> - set your Solana payout address in the console, then withdraw your accrued balance as $GGRID whenever you want. The split (75% you / 20% stakers / 5% treasury) is enforced on-chain.</P>
          <P style={{ color: DIM, fontSize: 13.5 }}>Earnings scale with network demand - a node that’s online and reliable earns more as traffic grows. Keep your provider token secret; anyone with it controls your node and payouts.</P>
        </DocSection>

        <DocSection id="provider" title="Provider API">
          <P>Put a GPU on the grid and earn 75% of every job it serves, paid in $GGRID. The one-line installer wraps all of this; the raw endpoints:</P>
          <Endpoint method="POST" path="/api/providers" />
          <Endpoint method="POST" path="/nodes/register" />
          <Endpoint method="POST" path="/nodes/:id/heartbeat" />
          <Endpoint method="GET" path="/api/provider/earnings" />
          <Endpoint method="POST" path="/api/provider/payout" />
          <Code title="ONE-LINE INSTALLER">{`# Windows (PowerShell)
$env:PROVIDER_TOKEN="ggrid_pv_..."; irm ${origin}/install.ps1 | iex

# macOS - Apple Silicon (M4 / M5)
curl -fsSL ${origin}/install.sh | PROVIDER_TOKEN=ggrid_pv_... bash`}</Code>
        </DocSection>

        <DocSection id="errors" title="Errors & limits">
          <P>Standard HTTP status codes. Common ones:</P>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['401', 'Missing or invalid API key'],
              ['402', 'Insufficient balance - top up to continue'],
              ['429', 'Rate limit exceeded (per-key or per-IP signup cap)'],
              ['404', 'No node is serving the requested model'],
              ['502 / 503', 'All nodes failed / no capacity - retry shortly'],
            ].map(([code, msg]) => (
              <div key={code} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                <Pill color={CORE}>{code}</Pill>
                <span style={{ fontFamily: 'var(--display)', fontSize: 14.5, color: SUB }}>{msg}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 14 }}><P>Free-tier limits and per-model prices are listed on the <a href="#/pricing" style={{ color: ACCENT }}>Pricing</a> page.</P></div>
        </DocSection>
      </div>
    </div>
  )
}

/* three-column docs shell (RunPod-style: nav · content · on-this-page) */
function DocsLayout() {
  const active = useActiveSection(DOC_TOC.map(([id]) => id))
  return (
    <div className="console-enter" style={{ minHeight: '100vh', background: '#070b10', position: 'relative' }}>
      <PageGlow />
      <SiteHeader page="docs" />
      <div className="docs-grid">
        <DocsSidebar active={active} />
        <main className="docs-main console-tab">
          <DocsContent />
        </main>
        <DocsToc active={active} />
      </div>
      <SiteFooter />
    </div>
  )
}

/* $GGRID staking — public page, same shell/style as the other content pages. Embeds
   the exact <Staking /> panel the developer console mounts (signs with Phantom directly,
   so it works here without a login). Until the gateway has GGRID_STAKE_PROGRAM_ID set,
   the panel shows its own "not live yet" state. */
function StakingPage() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ ...LABEL, marginBottom: 12 }}>$GGRID · STAKING</div>
      <h1 style={{ ...H2, marginBottom: 10 }}>Stake $GGRID, earn from every job</h1>
      <p style={{ ...LEAD, marginBottom: 28 }}>
        Stake $GGRID and earn the 20% cut the network takes from every inference job. Rewards
        accrue on-chain in real time, and unstaking is instant — no lock-up.
      </p>
      <Suspense fallback={<p style={{ ...LEAD, color: SUB }}>Loading…</p>}>
        <StakingPanel />
      </Suspense>
    </div>
  )
}

/* ---------------- router entry ---------------- */
export default function Pages({ page }: { page: PageId }) {
  if (page === 'docs') return <DocsLayout />
  return (
    <PageShell page={page}>
      <div key={page} className="console-tab">
        {page === 'pricing' ? <Pricing /> : page === 'stats' ? <Stats /> : <StakingPage />}
      </div>
    </PageShell>
  )
}
