import { useEffect, useMemo, useRef, useState, lazy, Suspense, type CSSProperties, type ReactNode } from 'react'
import Lenis from 'lenis'
import { scroll } from './scroll'
import { session } from './session'
import { api as gateway, type Stats } from './api'
import Bubbles from './Bubbles'

const compact = (n: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)

const SceneCanvas = lazy(() => import('./SceneCanvas'))
const PreloaderScene = lazy(() => import('./SceneCanvas').then((m) => ({ default: m.PreloaderG })))
const Ocean = lazy(() => import('./Ocean'))
const Dashboard = lazy(() => import('./ConsoleRoot')) // Dashboard wrapped in PrivyProvider (console-only chunk)
const Pages = lazy(() => import('./Pages'))

const X_URL = 'https://x.com/GpuGridApp'
const GGRID_CA = 'e4gi5NCxK3Eb7HqXV1Rskc3dZtH4hcHTF8dCfa5EASY'
const MAX_DEPTH = 3500

// Copyable $GGRID contract-address badge shown in the header next to the wordmark.
function CaBadge() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(GGRID_CA)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = GGRID_CA
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* clipboard unavailable */ }
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  const short = `${GGRID_CA.slice(0, 4)}…${GGRID_CA.slice(-4)}`
  return (
    <button
      type="button"
      onClick={copy}
      className="ca-badge"
      title={copied ? 'Copied!' : `Copy $GGRID contract address\n${GGRID_CA}`}
      aria-label="Copy $GGRID contract address"
    >
      <span className="ca-badge__tag">CA</span>
      <span className="ca-badge__addr">{short}</span>
      {copied ? (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
      )}
    </button>
  )
}

/* deterministic pseudo-random (matches the handoff source) */
const _r = (i: number) => {
  const x = Math.sin(i * 97.13 + 11.7) * 43758.5453
  return x - Math.floor(x)
}

const GPU = ['RTX 4090', 'RTX 4080', 'RTX 3090', 'A100 80G', 'RTX 4070', 'L40S', 'RTX 3080', 'H100']
const REG = ['us-east', 'eu-west', 'ap-south', 'us-west', 'eu-north', 'sa-east']
const TIERS: [string, number][] = [
  ['RTX 3060', 90],
  ['RTX 4070', 180],
  ['RTX 4090', 420],
  ['A100 80G', 760],
]

/* The boot preloader plays once per full page load. The hash router never
   reloads the page, so this module flag survives #/ ↔ #/app navigation and
   keeps the preloader from replaying when you come back from the console. */
let bootPreloaderPlayed = false

/* ---------- preloader: the glass G assembles from shards as the page loads ---------- */
function Preloader() {
  const progressRef = useRef(0)
  const readyRef = useRef(false) // set on the 3D scene's first frame
  const [pct, setPct] = useState(0)
  const [done, setDone] = useState(false)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let raf = 0
    let start = 0
    let fontsReady = false
    document.fonts?.ready.then(() => {
      fontsReady = true
    })
    const tick = (t: number) => {
      // hold fully scattered (progress 0) until the shards are actually on screen
      if (!readyRef.current) {
        start = t
        raf = requestAnimationFrame(tick)
        return
      }
      const elapsed = t - start
      let target = Math.min(0.9, elapsed / 2000)
      if (fontsReady && elapsed > 1600) target = 1
      progressRef.current += (target - progressRef.current) * 0.07
      const p = progressRef.current
      setPct(Math.round(p * 100))
      if (p > 0.996) {
        progressRef.current = 1
        setPct(100)
        setDone(true)
        window.setTimeout(() => setGone(true), 950)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  if (gone) return null
  return (
    <div className={`preloader${done ? ' done' : ''}`} aria-hidden="true">
      <div className="preloader__stage">
        <Suspense fallback={null}>
          <PreloaderScene progressRef={progressRef} onReady={() => (readyRef.current = true)} />
        </Suspense>
      </div>
      <div className="preloader__meta">
        <div className="preloader__wm">GPUGRID</div>
        <div className="preloader__bar">
          <i style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        <div className="preloader__pct mono">{String(pct).padStart(3, '0')} · DESCENDING</div>
      </div>
    </div>
  )
}

/* Headline line - plain text (no decode animation). */
function Scramble({ text, style, className }: { text: string; style?: CSSProperties; className?: string }) {
  return (
    <span className={className} style={style}>
      {text}
    </span>
  )
}

/* reveal-on-enter - scroll-triggered; direction + staggered delay */
type RevealDir = 'up' | 'down' | 'left' | 'right' | 'scale'
function Reveal({
  children,
  style,
  dir = 'up',
  delay = 0,
  className = '',
}: {
  children: ReactNode
  style?: CSSProperties
  dir?: RevealDir
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (el.classList.add('in'), io.unobserve(el))),
      { rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return (
    <div
      ref={ref}
      className={`reveal reveal-${dir} ${className}`}
      style={{ ...style, ['--reveal-delay' as string]: `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  )
}

/* count-up number */
function useCountUp(target: number, ms = 480) {
  const [n, setN] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = from.current
    const delta = target - start
    let raf = 0
    let t0 = 0
    const step = (t: number) => {
      if (!t0) t0 = t
      const p = Math.min(1, (t - t0) / ms)
      setN(Math.round(start + delta * (1 - Math.pow(1 - p, 3))))
      if (p < 1) raf = requestAnimationFrame(step)
      else from.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return n
}

/* ---------- wallet (real Phantom connect) ---------- */
function useWallet() {
  const [wallet, setWalletState] = useState<string | null>(() => session.wallet())
  // "Signed in" = we already hold an API key or a connected wallet - used only
  // to light the "Console" entry. Connecting a wallet does NOT open the console.
  const loggedIn = !!(session.apiKey() || wallet)
  async function connect() {
    const sol = (window as any).solana
    if (sol?.isPhantom) {
      try {
        const res = await sol.connect()
        const k = res.publicKey.toString()
        session.setWallet(k)
        setWalletState(k)
      } catch {
        /* dismissed → stay on the page */
      }
    } else {
      window.open('https://phantom.app/', '_blank', 'noopener')
    }
  }
  function disconnect() {
    try {
      ;(window as any).solana?.disconnect?.()
    } catch {
      /* ignore */
    }
    // Disconnecting is a full sign-out: drop the wallet AND the dev session
    // (API key / user id), so the console no longer shows as "signed in".
    session.signOut()
    setWalletState(null)
  }
  return { wallet, loggedIn, connect, disconnect }
}

/* ---------- wallet control: icon + connected check, click opens copy/disconnect ---------- */
function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </svg>
  )
}

function WalletControl({ wallet, connect, disconnect }: { wallet: string | null; connect: () => void; disconnect: () => void }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  // not connected → cyan wallet icon that links a wallet (no console navigation)
  if (!wallet) {
    return (
      <button onClick={connect} className="btn-cyan" aria-label="Connect wallet" title="Connect wallet" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 38, color: '#06080b', background: '#5fd4e2', border: '1px solid #5fd4e2', borderRadius: 8, cursor: 'pointer', boxShadow: '0 0 22px rgba(95,212,226,.35)', transition: 'filter .2s' }}>
        <WalletIcon />
      </button>
    )
  }

  const short = wallet.slice(0, 4) + '…' + wallet.slice(-4)
  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet!)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard blocked */
    }
  }

  // connected → wallet icon with a green check; click opens the menu
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="btn-x"
        aria-label="Wallet connected - open menu"
        aria-expanded={open}
        title={short}
        style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 38, border: '1px solid rgba(63,208,126,.45)', borderRadius: 8, color: '#cdd9e4', background: 'rgba(63,208,126,.08)', cursor: 'pointer', transition: 'background .25s, border-color .25s' }}
      >
        <WalletIcon />
        <span
          aria-hidden
          style={{ position: 'absolute', right: -4, top: -4, width: 14, height: 14, borderRadius: '50%', background: '#3fd07e', color: '#06140b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, border: '2px solid #070b10', lineHeight: 1 }}
        >
          ✓
        </span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 10px)',
            right: 0,
            minWidth: 210,
            background: 'rgba(10,15,21,.97)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid rgba(140,158,176,.22)',
            borderRadius: 12,
            padding: 8,
            boxShadow: '0 18px 50px rgba(0,0,0,.55)',
            zIndex: 60,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 10px' }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#3fd07e', boxShadow: '0 0 8px rgba(63,208,126,.9)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#e8f0f8', letterSpacing: '.04em' }}>{short}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: '#6a7d8e', letterSpacing: '.14em', marginLeft: 'auto' }}>LINKED</span>
          </div>
          <button onClick={copy} className="wallet-menu-item" style={WALLET_ITEM}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2" />
              <path d="M5 15V5a2 2 0 0 1 2-2h10" />
            </svg>
            {copied ? 'Copied' : 'Copy address'}
          </button>
          <button onClick={() => { disconnect(); setOpen(false) }} className="wallet-menu-item" style={{ ...WALLET_ITEM, color: '#f0a892' }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}

const WALLET_ITEM: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '.03em',
  color: '#cdd9e4',
  background: 'transparent',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  textAlign: 'left',
}

/* ---------- interactive node cavern ---------- */
interface Node {
  id: number
  left: number
  top: number
  leftPct: number
  topPct: number
  on: boolean
  gpu: string
  region: string
  tflops: number
  dur: number
  delay: number
}
function NodeCavern() {
  const { nodes, links, onlineCount } = useMemo(() => {
    const ns: Node[] = []
    let id = 0
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        const left = 46 + c * 92
        const top = 40 + r * 74
        ns.push({
          id,
          left,
          top,
          leftPct: (left / 460) * 100,
          topPct: (top / 300) * 100,
          on: _r(id * 3 + 1) > 0.16,
          gpu: GPU[Math.floor(_r(id * 7 + 2) * GPU.length)],
          region: REG[Math.floor(_r(id * 5 + 3) * REG.length)],
          tflops: 40 + Math.round(_r(id * 9 + 4) * 120),
          dur: 2.4 + _r(id * 11 + 5) * 2.6,
          delay: _r(id * 13 + 6) * 2.4,
        })
        id++
      }
    }
    const pairs = [
      [0, 7],
      [3, 12],
      [6, 18],
      [9, 14],
      [2, 16],
      [11, 19],
    ]
    const ls = pairs
      .map(([ai, bi], i) => {
        const a = ns[ai]
        const b = ns[bi]
        if (!a || !b) return null
        const mx = (a.left + b.left) / 2
        const my = (a.top + b.top) / 2 - 40
        return { d: `M ${a.left} ${a.top} Q ${mx} ${my} ${b.left} ${b.top}`, dur: (3 + i * 0.7).toFixed(1) + 's' }
      })
      .filter(Boolean) as { d: string; dur: string }[]
    return { nodes: ns, links: ls, onlineCount: ns.filter((n) => n.on).length }
  }, [])

  const [hover, setHover] = useState<Node | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  useEffect(() => {
    let alive = true
    gateway
      .stats()
      .then((s) => alive && setStats(s))
      .catch(() => {}) // gateway not reachable (e.g. static preview) → keep placeholders
    return () => {
      alive = false
    }
  }, [])
  const liveOnline = stats ? stats.onlineNodes : onlineCount
  return (
    <Reveal dir="right" delay={120} style={{ display: 'flex', flexDirection: 'column', gap: 18, alignItems: 'center' }}>
      <div style={{ position: 'relative', width: 460, maxWidth: '100%' }}>
        <div
          style={{ position: 'absolute', inset: -1, border: '1px solid rgba(140,158,176,.16)', borderRadius: 14, pointerEvents: 'none' }}
        />
        <svg viewBox="0 0 460 300" style={{ display: 'block', width: '100%', height: 'auto', overflow: 'visible' }}>
          {links.map((lk, i) => (
            <g key={i}>
              <path d={lk.d} fill="none" stroke="rgba(95,212,226,.22)" strokeWidth="1" />
              <circle r="2.6" fill="#5fd4e2">
                <animateMotion dur={lk.dur} repeatCount="indefinite" path={lk.d} />
              </circle>
            </g>
          ))}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.id}
            className="node-rig"
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover((h) => (h?.id === n.id ? null : h))}
            style={{
              position: 'absolute',
              left: `${n.leftPct}%`,
              top: `${n.topPct}%`,
              width: 30,
              height: 30,
              margin: '-15px 0 0 -15px',
              borderRadius: 7,
              border: `1px solid ${n.on ? 'rgba(95,212,226,.5)' : 'rgba(140,158,176,.2)'}`,
              background: n.on ? 'rgba(95,212,226,.07)' : 'rgba(140,158,176,.03)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              transition: 'box-shadow .2s, border-color .2s',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: n.on ? '#5fd4e2' : 'rgba(140,158,176,.4)',
                boxShadow: n.on ? '0 0 9px rgba(95,212,226,.9)' : 'none',
                animation: `nodePulse ${n.dur}s ease-in-out infinite`,
                animationDelay: `${n.delay}s`,
              }}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          width: 460,
          maxWidth: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontFamily: 'var(--mono)',
          padding: '11px 15px',
          border: '1px solid rgba(140,158,176,.18)',
          borderRadius: 10,
          background: 'rgba(10,14,19,.5)',
        }}
      >
        {hover ? (
          <>
            <b style={{ fontSize: 13, color: '#e8f0f8', fontWeight: 700 }}>{hover.gpu}</b>
            <span style={{ fontSize: 11, color: '#6a7d8e' }}>
              {hover.region} · {hover.tflops} TFLOPS · {hover.on ? 'online' : 'offline'}
            </span>
          </>
        ) : (
          <>
            <b style={{ fontSize: 13, color: '#e8f0f8', fontWeight: 700 }}>{liveOnline} rigs online</b>
            <span style={{ fontSize: 11, color: '#6a7d8e' }}>hover a rig to inspect</span>
          </>
        )}
      </div>
      <div
        style={{
          width: 460,
          maxWidth: '100%',
          display: 'grid',
          gridTemplateColumns: 'repeat(4,1fr)',
          gap: 1,
          background: 'rgba(140,158,176,.14)',
          border: '1px solid rgba(140,158,176,.14)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        {[
          [stats ? String(stats.onlineNodes) : String(liveOnline), 'GPUS ONLINE'],
          [stats ? String(stats.models.length) : '-', 'MODELS'],
          [stats ? compact(stats.totalJobs) : '-', 'JOBS RUN'],
          [stats ? compact(stats.users) : '-', 'DEVELOPERS'],
        ].map(([v, l]) => (
          <div key={l} style={{ background: 'rgba(8,11,15,.85)', padding: '14px 12px' }}>
            <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 24, color: '#e8f0f8' }}>{v}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.1em', color: '#6a7d8e', marginTop: 4 }}>{l}</div>
          </div>
        ))}
      </div>
    </Reveal>
  )
}

/* ---------- provider earnings rig ---------- */
function Estimator() {
  const [tier, setTier] = useState(2)
  const [util, setUtil] = useState(60)
  const target = Math.round(TIERS[tier][1] * (util / 100) * 24)
  const shown = useCountUp(target)
  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid rgba(140,158,176,.2)',
        borderRadius: 14,
        background: 'rgba(11,15,20,.9)',
        padding: 26,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.16em', color: '#9fb4c6' }}>PROVIDER YIELD</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: 'var(--mono)', fontSize: 10, color: '#5fd4e2' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5fd4e2', boxShadow: '0 0 8px #5fd4e2' }} />
          MINING
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 9, marginBottom: 22 }}>
        {TIERS.map(([name], i) => (
          <button
            key={name}
            className="tier-btn"
            aria-pressed={i === tier}
            onClick={() => setTier(i)}
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              padding: '12px 10px',
              borderRadius: 9,
              cursor: 'pointer',
              textAlign: 'left',
              border: `1px solid ${i === tier ? 'rgba(95,212,226,.6)' : 'rgba(140,158,176,.2)'}`,
              background: i === tier ? 'rgba(95,212,226,.1)' : 'rgba(140,158,176,.03)',
              color: i === tier ? '#e8f0f8' : '#8aa0b4',
              transition: 'all .2s',
            }}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: '#9fb4c6',
          marginBottom: 10,
        }}
      >
        <span>UTILIZATION</span>
        <b style={{ color: '#5fd4e2' }}>{util}%</b>
      </div>
      <input
        type="range"
        className="rig"
        min={5}
        max={100}
        value={util}
        onChange={(e) => setUtil(+e.target.value)}
        aria-label="GPU utilization percent"
        style={{ width: '100%', marginBottom: 26 }}
      />
      <div style={{ borderTop: '1px solid rgba(140,158,176,.16)', paddingTop: 20, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 46, lineHeight: 1, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
          {shown.toLocaleString('en-US')}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#6a7d8e' }}>$GGRID / day est.</span>
      </div>
    </div>
  )
}

/* ---------- code terminal ---------- */
type Tok = { t: string; c: string }
const CODE: Record<string, Tok[][]> = (() => {
  const c = '#5d6f80'
  const s = '#5fd4e2'
  const k = '#cdd9e4'
  const d = '#8fa2b2'
  const f = '#e6a44b'
  return {
    curl: [
      [{ t: '# point any OpenAI client at the grid', c }],
      [{ t: 'curl', c: k }, { t: ' https://gpugrid.app/v1/chat/completions \\', c: d }],
      [{ t: '  -H ', c: d }, { t: '"Authorization: Bearer ggrid_sk_…"', c: s }, { t: ' \\', c: d }],
      [{ t: '  -d ', c: d }, { t: '\'{ "model": "llama3:8b", "messages": [...] }\'', c: s }],
    ],
    python: [
      [{ t: 'from', c: f }, { t: ' openai ', c: d }, { t: 'import', c: f }, { t: ' OpenAI', c: d }],
      [{ t: '', c: d }],
      [{ t: 'client = OpenAI(', c: d }],
      [{ t: '    base_url=', c: d }, { t: '"https://gpugrid.app/v1"', c: s }, { t: ',', c: d }],
      [{ t: '    api_key=', c: d }, { t: '"ggrid_sk_…"', c: s }, { t: ',', c: d }],
      [{ t: ')', c: d }],
      [{ t: 'r = client.chat.completions.create(model=', c: d }, { t: '"llama3:8b"', c: s }, { t: ')', c: d }],
    ],
    node: [
      [{ t: 'import', c: f }, { t: ' OpenAI ', c: d }, { t: 'from', c: f }, { t: ' "openai"', c: s }, { t: ';', c: d }],
      [{ t: '', c: d }],
      [{ t: 'const', c: f }, { t: ' ai = ', c: d }, { t: 'new', c: f }, { t: ' OpenAI({', c: d }],
      [{ t: '  baseURL: ', c: d }, { t: '"https://gpugrid.app/v1"', c: s }, { t: ',', c: d }],
      [{ t: '  apiKey: ', c: d }, { t: '"ggrid_sk_…"', c: s }, { t: ',', c: d }],
      [{ t: '});', c: d }],
      [{ t: 'await', c: f }, { t: ' ai.chat.completions.create({ model: ', c: d }, { t: '"llama3:8b"', c: s }, { t: ' });', c: d }],
    ],
  }
})()
function CodeTerminal() {
  const [tab, setTab] = useState<keyof typeof CODE>('curl')
  const tabs: (keyof typeof CODE)[] = ['curl', 'python', 'node']
  return (
    <div
      style={{
        border: '1px solid rgba(140,158,176,.2)',
        borderRadius: 14,
        background: 'rgba(6,9,12,.92)',
        overflow: 'hidden',
        boxShadow: '0 24px 60px -20px rgba(0,0,0,.7)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '13px 16px',
          borderBottom: '1px solid rgba(140,158,176,.14)',
          background: 'rgba(12,17,22,.7)',
        }}
      >
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#e6a44b' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#5fd4e2' }} />
        <span style={{ width: 11, height: 11, borderRadius: '50%', background: 'rgba(140,158,176,.4)' }} />
        <div style={{ display: 'flex', gap: 4, marginLeft: 14 }}>
          {tabs.map((t) => (
            <button
              key={t}
              className="tab-btn"
              onClick={() => setTab(t)}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '5px 12px',
                borderRadius: 6,
                cursor: 'pointer',
                border: 'none',
                background: tab === t ? 'rgba(95,212,226,.14)' : 'transparent',
                color: tab === t ? '#5fd4e2' : '#6a7d8e',
                transition: 'all .2s',
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: '#4d5d6c' }}>request</span>
      </div>
      <div style={{ padding: '20px', fontFamily: 'var(--mono)', fontSize: 13, lineHeight: 1.85, whiteSpace: 'pre', overflowX: 'auto' }}>
        {CODE[tab].map((line, i) => (
          <div key={i} style={{ minHeight: '1.85em' }}>
            {line.map((tok, j) => (
              <span key={j} style={{ color: tok.c }}>
                {tok.t}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const SPLIT: [string, string][] = [
  ['Providers', '75%'],
  ['Burn', '12.5%'],
  ['Stakers', '7.5%'],
  ['Treasury', '5%'],
]
function SplitBars() {
  return (
    <Reveal dir="scale" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {SPLIT.map(([label, pct], i) => (
        <div key={label}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              fontFamily: 'var(--mono)',
              marginBottom: 9,
            }}
          >
            <span style={{ fontSize: 14, color: '#cdd9e4', letterSpacing: '.04em' }}>{label}</span>
            <b style={{ fontSize: 16, color: '#fff', fontWeight: 700 }}>{pct}</b>
          </div>
          <div style={{ height: 7, borderRadius: 4, background: 'rgba(140,158,176,.12)', overflow: 'hidden' }}>
            <div
              className="split-fill"
              style={{ height: '100%', width: pct, borderRadius: 4, background: '#5fd4e2', ['--fill-delay' as string]: `${0.15 + i * 0.12}s` } as CSSProperties}
            />
          </div>
        </div>
      ))}
    </Reveal>
  )
}

/* ---------- section level marker ---------- */
function Marker({
  no,
  name,
  depth,
  core,
  dir = 'up',
  delay = 0,
}: {
  no: string
  name: string
  depth: string
  core?: boolean
  dir?: RevealDir
  delay?: number
}) {
  return (
    <Reveal
      dir={dir}
      delay={delay}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '.2em',
        color: core ? '#e6a44b' : '#5fd4e2',
        marginBottom: 28,
      }}
    >
      <span>{no}</span>
      <span style={{ color: core ? '#9a7d52' : '#6a7d8e' }}>{name}</span>
      <span style={{ flex: 1, height: 1, background: core ? 'rgba(230,164,75,.25)' : 'rgba(140,158,176,.2)' }} />
      <span style={{ color: core ? '#9a7d52' : '#6a7d8e' }}>{depth}</span>
    </Reveal>
  )
}

const H2 = (style?: CSSProperties): CSSProperties => ({
  margin: 0,
  fontFamily: 'var(--display)',
  fontWeight: 200,
  fontSize: 'clamp(27px,8vw,62px)',
  lineHeight: 1.05,
  overflowWrap: 'break-word',
  ...style,
})
const BODY: CSSProperties = {
  margin: '26px 0 0',
  maxWidth: 420,
  fontFamily: 'var(--display)',
  fontWeight: 300,
  fontSize: 18,
  lineHeight: 1.6,
  color: '#9fb4c6',
}
const SECTION: CSSProperties = { minHeight: '86vh', display: 'flex', alignItems: 'center', padding: 'clamp(68px, 13vw, 110px) clamp(20px, 6vw, 60px)', position: 'relative' }

function Site() {
  const wallet = useWallet()
  // Only show the boot preloader on the genuine first load - not when returning
  // from the console (the SPA stays mounted, so the module flag persists).
  const [showPreloader] = useState(() => !bootPreloaderPlayed)
  useEffect(() => {
    bootPreloaderPlayed = true
  }, [])
  const rootRef = useRef<HTMLDivElement>(null)
  const voidRef = useRef<HTMLDivElement>(null)
  const raysRef = useRef<HTMLDivElement>(null)
  const waterRef = useRef<HTMLDivElement>(null)
  const darkRef = useRef<HTMLDivElement>(null)
  const shaftRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const coreGlowRef = useRef<HTMLDivElement>(null)
  const heroScrimRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const cueRef = useRef<HTMLDivElement>(null)
  const depthNumRef = useRef<HTMLSpanElement>(null)
  const depthFillRef = useRef<HTMLDivElement>(null)
  const depthDotRef = useRef<HTMLDivElement>(null)
  const depthLevelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true })
    let tgtP = 0
    let curP = 0
    let lastY = 0
    scroll.vh = window.innerHeight

    const levelFor = (d: number) => {
      if (d < 180) return 'SURFACE'
      if (d < 1150) return '01 · NETWORK'
      if (d < 1950) return '02 · PROVIDERS'
      if (d < 2750) return '03 · DEVELOPERS'
      if (d < 3420) return '04 · THE CORE'
      return 'BEDROCK'
    }
    const clamp = (x: number) => Math.min(1, Math.max(0, x))
    const fmt = (n: number) => n.toLocaleString('en-US')

    lenis.on('scroll', ({ scroll: s, limit }: { scroll: number; limit: number }) => {
      tgtP = limit > 0 ? s / limit : 0
      const y = s
      const h = headerRef.current
      if (h) {
        h.style.transform = y > lastY && y > 140 ? 'translateY(-104%)' : 'translateY(0)'
        if (y > 30) {
          h.style.background = 'rgba(7,9,13,.72)'
          h.style.borderBottomColor = 'rgba(140,158,176,.14)'
          h.style.backdropFilter = 'blur(12px)'
          ;(h.style as any).webkitBackdropFilter = 'blur(12px)'
        } else {
          h.style.background = 'transparent'
          h.style.borderBottomColor = 'transparent'
          h.style.backdropFilter = 'none'
          ;(h.style as any).webkitBackdropFilter = 'none'
        }
        lastY = y
      }
      if (cueRef.current) cueRef.current.style.opacity = tgtP > 0.015 ? '0' : '1'
    })

    let raf = 0
    const loop = (t: number) => {
      lenis.raf(t)
      curP += (tgtP - curP) * 0.1
      const p = curP
      const max = document.documentElement.scrollHeight - window.innerHeight || 1
      const y = p * max
      const depth = Math.round(p * MAX_DEPTH)

      if (depthNumRef.current) depthNumRef.current.textContent = '−' + fmt(depth)
      if (depthFillRef.current) depthFillRef.current.style.height = p * 100 + '%'
      if (depthDotRef.current) depthDotRef.current.style.top = p * 100 + '%'
      if (depthLevelRef.current) {
        const lv = levelFor(depth)
        if (depthLevelRef.current.textContent !== lv) depthLevelRef.current.textContent = lv
        depthLevelRef.current.style.color = depth > 2750 ? '#e6a44b' : '#5fd4e2'
      }
      if (surfaceRef.current) {
        surfaceRef.current.style.transform = `translateY(${-y * 0.45}px)`
        surfaceRef.current.style.opacity = String(clamp(1 - p * 3.4))
      }
      if (heroScrimRef.current) heroScrimRef.current.style.opacity = String(clamp(1 - p * 4))
      // ambient god rays - only over the hero, gone before the water rises
      // (transform is owned by the godraySway animation, so only fade here)
      if (raysRef.current) raysRef.current.style.opacity = String(clamp(1 - p * 6))
      // realistic water - its surface is pinned to the intro headline's page position
      // (driven by the REAL scroll, like the content, so the waterline sits exactly AT the text)
      if (waterRef.current) {
        const vhNow = window.innerHeight || 1
        const sy = window.scrollY
        const surfaceY = 1.34 * vhNow - sy // headline center sits ~1.34 viewports down the page
        waterRef.current.style.transform = `translateY(${surfaceY}px)`
        waterRef.current.style.opacity = String(clamp(1 - (sy / vhNow - 1.7) / 0.6)) // fade once fully under
      }
      // visibility closes in deep
      if (shaftRef.current) shaftRef.current.style.opacity = String(clamp((p - 0.06) * 1.5))
      // sharp onset of darkness through the mid-descent, near-black at the bottom
      if (darkRef.current) darkRef.current.style.opacity = String(clamp((p - 0.26) / 0.34) * 0.92)
      // molten core burns in early and dominates the deep
      if (coreGlowRef.current) coreGlowRef.current.style.opacity = String(clamp((p - 0.48) / 0.3))
      // the water column dims and goes colder/bluer the deeper you sink
      if (voidRef.current) {
        voidRef.current.style.filter = `brightness(${1 - p * 0.82}) saturate(${1 + p * 0.4})`
      }
      const vh = window.innerHeight || 1
      scroll.vh = vh
      scroll.scrollY = y
      scroll.progress = p
      scroll.heroE = clamp(y / (vh * 0.85))
      scroll.gAlpha = clamp(1 - (y - vh * 0.55) / (vh * 0.5))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    const onPointer = (e: PointerEvent) => {
      scroll.pointer.x = (e.clientX / window.innerWidth) * 2 - 1
      scroll.pointer.y = (e.clientY / window.innerHeight) * 2 - 1
    }
    window.addEventListener('pointermove', onPointer)

    return () => {
      cancelAnimationFrame(raf)
      lenis.destroy()
      window.removeEventListener('pointermove', onPointer)
    }
  }, [])

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%' }}>
      {showPreloader && <Preloader />}

      {/* ===== fixed water background layers ===== */}
      {/* the water column - bright teal at the surface fading into the abyss */}
      <div
        ref={voidRef}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          background:
            'linear-gradient(180deg, #0e5168 0%, #0a3c52 20%, #07293c 44%, #051a28 66%, #020e16 86%, #01060c 100%)',
        }}
      />

      {/* surface light - sun glow + god rays slicing down through the water */}
      <div
        ref={raysRef}
        style={{
          position: 'fixed',
          inset: '-60px 0 0',
          zIndex: 1,
          pointerEvents: 'none',
          mixBlendMode: 'screen',
          willChange: 'transform, opacity',
          transformOrigin: 'top center',
          animation: 'godraySway 12s ease-in-out infinite',
          background:
            'radial-gradient(85% 55% at 50% -14%, rgba(150,228,240,.24) 0%, rgba(120,200,222,.06) 40%, transparent 66%), linear-gradient(94deg, transparent 14%, rgba(150,226,240,.10) 19%, transparent 25%, transparent 43%, rgba(150,226,240,.06) 49%, transparent 55%, transparent 70%, rgba(150,226,240,.11) 76%, transparent 82%, transparent 90%, rgba(150,226,240,.05) 95%, transparent 99%)',
          WebkitMaskImage: 'linear-gradient(180deg, #000 0%, rgba(0,0,0,.55) 42%, transparent 80%)',
          maskImage: 'linear-gradient(180deg, #000 0%, rgba(0,0,0,.55) 42%, transparent 80%)',
        }}
      />

      {/* realistic water - a surface that rises to meet the headline, deep water below it */}
      <div
        ref={waterRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '240vh',
          zIndex: 3,
          opacity: 0,
          pointerEvents: 'none',
          overflow: 'hidden',
          transform: 'translateY(120vh)',
          willChange: 'transform, opacity',
        }}
      >
        {/* underwater body - sunlit at the surface, deepening downward */}
        <div
          style={{
            position: 'absolute',
            top: 64,
            left: 0,
            right: 0,
            height: '240vh',
            background:
              'linear-gradient(180deg, #12697f 0%, #0c4d63 6%, #093a4e 14%, #07293a 28%, #051d2a 48%, #03141d 74%, #020d14 100%)',
          }}
        >
          {/* caustic light dappling just under the surface */}
          <div className="caustics" style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '64vh' }} />
        </div>
        {/* realistic 3D ocean surface (Gerstner waves) seen edge-on at the waterline */}
        <div
          style={{
            position: 'absolute',
            top: '-12vh',
            left: 0,
            right: 0,
            height: '72vh',
            WebkitMaskImage: 'linear-gradient(180deg, #000 0%, #000 74%, transparent 100%)',
            maskImage: 'linear-gradient(180deg, #000 0%, #000 74%, transparent 100%)',
          }}
        >
          <Suspense fallback={null}>
            <Ocean />
          </Suspense>
        </div>
      </div>

      {/* visibility closes in as you descend into the deep */}
      <div
        ref={shaftRef}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 2,
          opacity: 0,
          pointerEvents: 'none',
          background:
            'linear-gradient(90deg, rgba(2,4,7,.92) 0%, rgba(2,4,7,.28) 13%, transparent 30%, transparent 70%, rgba(2,4,7,.28) 87%, rgba(2,4,7,.92) 100%)',
        }}
      />

      <div
        ref={surfaceRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '100vh',
          zIndex: 2,
          pointerEvents: 'none',
          willChange: 'transform, opacity',
          backgroundImage: "url('/header.webp')",
          backgroundSize: 'cover',
          backgroundPosition: 'center 28%',
          filter: 'brightness(.66) contrast(1.06)',
          WebkitMaskImage: 'linear-gradient(180deg, #000 0%, #000 50%, rgba(0,0,0,.5) 73%, transparent 95%)',
          maskImage: 'linear-gradient(180deg, #000 0%, #000 50%, rgba(0,0,0,.5) 73%, transparent 95%)',
        }}
      />
      {/* sharp darkening - the deep goes near-black as you sink */}
      <div
        ref={darkRef}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 3,
          opacity: 0,
          pointerEvents: 'none',
          background: '#01040a',
        }}
      />
      {/* the molten $GGRID core - burns orange through the dark, backlighting the text */}
      <div
        ref={coreGlowRef}
        style={{
          position: 'fixed',
          left: '50%',
          bottom: -160,
          transform: 'translateX(-50%)',
          width: 1700,
          height: 1080,
          zIndex: 5,
          opacity: 0,
          pointerEvents: 'none',
          mixBlendMode: 'screen',
          willChange: 'opacity',
          animation: 'emberPulse 5.5s ease-in-out infinite',
          background:
            'radial-gradient(52% 50% at 50% 76%, rgba(255,186,96,.78) 0%, rgba(242,138,52,.42) 32%, rgba(186,72,20,.16) 58%, transparent 78%)',
        }}
      />
      <div
        ref={heroScrimRef}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 3,
          pointerEvents: 'none',
          background: 'radial-gradient(52% 44% at 50% 44%, rgba(6,9,13,.5) 0%, rgba(6,9,13,.22) 52%, transparent 80%)',
        }}
      />
      <Bubbles />
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 4,
          pointerEvents: 'none',
          boxShadow: 'inset 0 0 240px 30px rgba(0,0,0,.72)',
          background: 'radial-gradient(120% 80% at 50% 40%, transparent 55%, rgba(0,0,0,.45) 100%)',
        }}
      />

      {/* 3D glass G */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 6, pointerEvents: 'none' }}>
        <Suspense fallback={null}>
          <SceneCanvas />
        </Suspense>
      </div>

      {/* ===== header ===== */}
      <header
        ref={headerRef}
        className="site-header"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '18px 30px',
          transition: 'transform .45s cubic-bezier(.2,.7,.2,1), background .4s, border-color .4s',
          borderBottom: '1px solid transparent',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <a href="#top" style={{ display: 'flex', alignItems: 'center', gap: 13, textDecoration: 'none' }}>
            <img
              src="/logo.png"
              alt="GPUGrid"
              width={40}
              height={40}
              style={{ display: 'block', width: 40, height: 40, borderRadius: 9, border: '1px solid rgba(140,158,176,.3)' }}
            />
            <span style={{ lineHeight: 1.05 }}>
              <span style={{ display: 'block', fontFamily: 'var(--display)', fontWeight: 500, letterSpacing: '.16em', fontSize: 15, color: '#eef4fb' }}>
                GPUGRID
              </span>
              <span style={{ display: 'block', fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 10, letterSpacing: '.18em', color: '#5fd4e2', marginTop: 3 }}>
                $GGRID
              </span>
            </span>
          </a>
          <CaBadge />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* content pages - hidden on narrow screens to keep the header clean */}
          <nav className="landing-links" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {[
              ['#/pricing', 'Pricing'],
              ['#/docs', 'Docs'],
              ['#/stats', 'Network'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="link-dim"
                style={{ fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: '.04em', color: '#9fb4c6', textDecoration: 'none', padding: '8px 10px' }}
              >
                {label}
              </a>
            ))}
          </nav>
          {/* Always-visible entry to the personal console - styled as an
             outlined button so it reads as clickable, not hidden behind
             "Connect Wallet". */}
          <a
            href="#/app"
            className="nav-console btn-ghost"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontFamily: 'var(--mono)',
              fontWeight: 500,
              fontSize: 12,
              letterSpacing: '.06em',
              color: '#dce6f0',
              textDecoration: 'none',
              border: '1px solid rgba(140,158,176,.4)',
              borderRadius: 8,
              padding: '10px 15px',
              background: 'rgba(140,158,176,.06)',
              transition: 'background .25s, border-color .25s, color .25s',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: wallet.loggedIn ? '#3fd07e' : '#6a7d8e',
                boxShadow: wallet.loggedIn ? '0 0 8px rgba(63,208,126,.9)' : 'none',
              }}
            />
            {wallet.loggedIn ? 'My console' : 'Open console'}
          </a>
          <a
            href={X_URL}
            target="_blank"
            rel="noopener"
            className="btn-x"
            aria-label="GPUGrid on X"
            style={{
              display: 'flex',
              width: 38,
              height: 38,
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px solid rgba(140,158,176,.26)',
              borderRadius: 8,
              color: '#cdd9e4',
              textDecoration: 'none',
              transition: 'background .25s, border-color .25s',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <WalletControl wallet={wallet.wallet} connect={wallet.connect} disconnect={wallet.disconnect} />
        </div>
      </header>

      {/* ===== depth meter ===== */}
      <div
        className="depth-meter"
        style={{
          position: 'fixed',
          right: 26,
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 38,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          pointerEvents: 'none',
        }}
      >
        <div style={{ position: 'relative', width: 2, height: 250, background: 'rgba(140,158,176,.18)', borderRadius: 2 }}>
          <div ref={depthFillRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '0%', background: '#5fd4e2', borderRadius: 2 }} />
          <div ref={depthDotRef} style={{ position: 'absolute', top: '0%', left: '50%', width: 9, height: 9, margin: '-4.5px 0 0 -4.5px', borderRadius: '50%', background: '#5fd4e2', boxShadow: '0 0 12px rgba(95,212,226,.9)' }} />
        </div>
        <div style={{ textAlign: 'right' }}>
          <div ref={depthLevelRef} style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.22em', color: '#5fd4e2', marginBottom: 5 }}>
            SURFACE
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 3 }}>
            <span ref={depthNumRef} style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 30, letterSpacing: '.01em', color: '#e8f0f8', fontVariantNumeric: 'tabular-nums' }}>
              0
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#6a7d8e' }}>m</span>
          </div>
        </div>
      </div>

      {/* ===== content ===== */}
      <main id="top" style={{ position: 'relative', zIndex: 10 }}>
        {/* SURFACE / HERO */}
        <section style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', textAlign: 'center', padding: '120px 24px 46px' }}>
          <div ref={cueRef} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, transition: 'opacity .5s' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.28em', color: '#9fb4c6' }}>SCROLL TO DISASSEMBLE · DESCEND</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 16, color: '#5fd4e2', animation: 'ggCue 2.2s ease-in-out infinite' }}>↓</span>
          </div>
        </section>

        {/* INTRO / WORDMARK */}
        <section style={{ minHeight: '92vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '110px 24px 90px' }}>
          <Reveal dir="scale">
            <h1 style={{ margin: 0, fontFamily: 'var(--display)', fontWeight: 200, fontSize: 'clamp(46px, 9vw, 116px)', lineHeight: 0.98, letterSpacing: '.01em' }}>
              <Scramble text="The grid for" style={{ display: 'block' }} />
              <Scramble text="AI compute" style={{ display: 'block', fontWeight: 400, color: '#f2f7fc' }} />
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p style={{ margin: '26px 0 0', fontFamily: 'var(--display)', fontWeight: 300, fontSize: 'clamp(16px,2.2vw,21px)', color: '#9fb4c6', letterSpacing: '.02em' }}>
              Idle GPUs, mined into one on-demand AI supercloud.
            </p>
          </Reveal>
        </section>

        {/* LEVEL 01 - NETWORK */}
        <section style={SECTION}>
          <div className="grid2">
            <div>
              <Marker no="//01" name="NETWORK" depth="−620 m" />
              <Reveal delay={90}>
                <h2 style={H2()}>
                  <Scramble text="Compute without" style={{ display: 'block' }} />
                  <Scramble text="gatekeepers" style={{ display: 'block', fontWeight: 400 }} />
                </h2>
              </Reveal>
              <Reveal delay={180}>
                <p style={BODY}>
                  Idle cards across the world become one cavern of compute. Every job routes down to the cheapest healthy rig - no
                  datacenter, no gatekeeper.
                </p>
              </Reveal>
            </div>
            <NodeCavern />
          </div>
        </section>

        {/* LEVEL 02 - PROVIDERS */}
        <section style={SECTION}>
          <div className="grid2">
            <Reveal dir="scale" className="order2" style={{ order: 2 }}>
              <Estimator />
            </Reveal>
            <div style={{ order: 1 }}>
              <Marker no="//02" name="PROVIDERS" depth="−1,480 m" />
              <Reveal delay={90}>
                <h2 style={H2()}>
                  <Scramble text="Your GPU" style={{ display: 'block' }} />
                  <Scramble text="never sleeps" style={{ display: 'block', fontWeight: 400 }} />
                </h2>
              </Reveal>
              <Reveal delay={180}>
                <p style={BODY}>
                  One installer drops your card into the grid. It mines compute while you sleep - you keep{' '}
                  <b style={{ color: '#fff', fontWeight: 500 }}>75%</b> of every job, paid in $GGRID.
                </p>
              </Reveal>
              <Reveal delay={260}>
                <a
                  href="#/providers"
                  className="btn-solid"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 10,
                    marginTop: 32,
                    fontFamily: 'var(--mono)',
                    fontSize: 13,
                    letterSpacing: '.04em',
                    color: '#06080b',
                    background: '#e8f0f8',
                    padding: '14px 22px',
                    borderRadius: 9,
                    textDecoration: 'none',
                    transition: 'filter .2s',
                  }}
                >
                  Become a provider →
                </a>
              </Reveal>
            </div>
          </div>
        </section>

        {/* LEVEL 03 - DEVELOPERS */}
        <section style={SECTION}>
          <div className="grid2">
            <div>
              <Marker no="//03" name="DEVELOPERS" depth="−2,360 m" dir="left" />
              <Reveal dir="left" delay={90}>
                <h2 style={H2()}>
                  <Scramble text="OpenAI-compatible" style={{ display: 'block' }} />
                  <Scramble text="on demand" style={{ display: 'block', fontWeight: 400 }} />
                </h2>
              </Reveal>
              <Reveal dir="left" delay={180}>
                <p style={BODY}>
                  Point your existing OpenAI client at one endpoint. Same code, same SDKs - your jobs just run on the grid instead.
                </p>
              </Reveal>
            </div>
            <Reveal dir="right" delay={120}>
              <CodeTerminal />
            </Reveal>
          </div>
        </section>

        {/* LEVEL 04 - THE CORE */}
        <section id="core" style={{ ...SECTION, padding: '140px 6vw 120px', position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%,-50%)',
              width: 560,
              height: 560,
              borderRadius: '50%',
              pointerEvents: 'none',
              background: 'radial-gradient(50% 50% at 50% 50%, rgba(230,164,75,.22) 0%, rgba(230,120,50,.06) 45%, transparent 70%)',
              animation: 'coreBreath 6s ease-in-out infinite',
            }}
          />
          <div className="grid2" style={{ position: 'relative' }}>
            <div>
              <Marker no="//04" name="THE CORE" depth="−3,200 m" core />
              <Reveal delay={90}>
                <h2 style={H2({ fontSize: 'clamp(30px,8.6vw,66px)' })}>
                  <Scramble text="One token" style={{ display: 'block' }} />
                  <Scramble
                    text="powers the grid"
                    style={{
                      display: 'block',
                      fontWeight: 400,
                      color: '#f0ab54',
                      textShadow: '0 0 32px rgba(238,140,52,.6), 0 0 12px rgba(255,182,92,.45)',
                    }}
                  />
                </h2>
              </Reveal>
              <Reveal delay={180}>
                <p style={{ ...BODY, fontSize: 20, maxWidth: 460 }}>
                  Down at the core, every job is paid in <b style={{ color: '#f0ab54' }}>$GGRID</b> and settled on{' '}
                  <b style={{ color: '#cdd9e4' }}>Solana</b>. The token is the rail the whole network runs on - not decoration.
                </p>
              </Reveal>
              <Reveal delay={320}>
                <p style={{ margin: '26px 0 0', maxWidth: 460, fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.75, color: '#8fa3b5' }}>
                  Settlement runs on Solana. Compute is metered off-chain today; the on-chain payout splitter is written and
                  validated on devnet - deposits into the vault and provider payouts are live-tested there.
                </p>
              </Reveal>
              <Reveal delay={340}>
                <div
                  style={{
                    marginTop: 30,
                    maxWidth: 440,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '16px 18px',
                    border: '1px solid rgba(95,212,226,.22)',
                    borderRadius: 12,
                    background: 'rgba(95,212,226,.045)',
                  }}
                >
                  <div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.22em', color: '#5fd4e2', marginBottom: 6 }}>STAKING</div>
                    <div style={{ fontFamily: 'var(--display)', fontWeight: 300, fontSize: 16, color: '#cdd9e4', lineHeight: 1.4 }}>
                      Stake $GGRID, earn a share of every job
                    </div>
                  </div>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      letterSpacing: '.14em',
                      color: '#06080b',
                      background: '#5fd4e2',
                      padding: '5px 10px',
                      borderRadius: 20,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    SOON
                  </span>
                </div>
              </Reveal>
            </div>
            <SplitBars />
          </div>
        </section>

        {/* FOOTER / BEDROCK */}
        <footer style={{ minHeight: '80vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '100px 24px 70px', position: 'relative' }}>
          <Reveal>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.28em', color: '#9a7d52', marginBottom: 26 }}>−3,500 m · BEDROCK</div>
            <h2 style={{ margin: 0, fontFamily: 'var(--display)', fontWeight: 200, fontSize: 'clamp(44px,8vw,96px)', lineHeight: 1 }}>
              <Scramble
                text="Join the grid"
                style={{
                  display: 'block',
                  color: '#fff3e6',
                  textShadow: '0 0 36px rgba(236,130,46,.55), 0 0 12px rgba(255,176,86,.4)',
                }}
              />
            </h2>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'center', marginTop: 40, flexWrap: 'wrap' }}>
              <a
                href="#/app"
                className="btn-cyan"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  letterSpacing: '.04em',
                  color: '#06080b',
                  background: '#5fd4e2',
                  border: 'none',
                  padding: '15px 26px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  textDecoration: 'none',
                  boxShadow: '0 0 26px rgba(95,212,226,.4)',
                  transition: 'filter .2s',
                }}
              >
                Open console →
              </a>
              <a
                href={X_URL}
                target="_blank"
                rel="noopener"
                className="btn-ghost"
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  letterSpacing: '.04em',
                  color: '#e8f0f8',
                  border: '1px solid rgba(140,158,176,.3)',
                  padding: '15px 26px',
                  borderRadius: 9,
                  textDecoration: 'none',
                  transition: 'border-color .2s',
                }}
              >
                Follow on X
              </a>
            </div>
          </Reveal>
          <div
            style={{
              marginTop: 'auto',
              paddingTop: 70,
              width: '100%',
              maxWidth: 1180,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 16,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: '#c4d0dd',
              textShadow: '0 1px 10px rgba(2,5,9,.92), 0 0 3px rgba(2,5,9,.85)',
              borderTop: '1px solid rgba(180,200,220,.22)',
            }}
          >
            <span style={{ paddingTop: 20 }}>© 2026 GPUGRID</span>
            <div style={{ display: 'flex', gap: 22, paddingTop: 20 }}>
              <a href={X_URL} target="_blank" rel="noopener" className="link-dim" style={{ color: '#e0eaf4', textDecoration: 'none' }}>
                X (Twitter)
              </a>
              <a href="#top" className="link-dim" style={{ color: '#e0eaf4', textDecoration: 'none' }}>
                Back to surface ↑
              </a>
            </div>
            <span style={{ paddingTop: 20 }}>Built by GPUGrid</span>
          </div>
        </footer>
      </main>
    </div>
  )
}

/* ---------- hash router: landing (#/) vs console (#/app, #/providers) ---------- */
export default function App() {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, ''))
  useEffect(() => {
    const on = () => {
      setRoute(window.location.hash.replace(/^#\/?/, ''))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  if (route === 'app' || route === 'providers') {
    return (
      <Suspense fallback={null}>
        <Dashboard tab={route} />
      </Suspense>
    )
  }
  if (route === 'pricing' || route === 'docs' || route === 'stats') {
    return (
      <Suspense fallback={null}>
        <Pages page={route} />
      </Suspense>
    )
  }
  return <Site />
}
