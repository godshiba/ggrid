import { Staking } from './Dashboard'

/* Public, login-free preview of the console Staking panel — reached at #/staking.
   Renders the exact same <Staking /> component the developer console mounts, so what
   you see here is what a logged-in user sees. Purely for previewing the UI. */
export default function StakingStandalone() {
  return (
    <div style={{ minHeight: '100vh', background: '#0d0e11', color: '#e8f0f8', padding: '48px 20px' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <a
          href="#/"
          style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, color: '#6a7d8e', textDecoration: 'none' }}
        >
          ← Back to site
        </a>
        <h1
          style={{
            fontFamily: "'Saira', system-ui, sans-serif", fontWeight: 300, fontSize: 30, color: '#e8f0f8',
            margin: '18px 0 6px',
          }}
        >
          $GGRID Staking
        </h1>
        <p
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 11, letterSpacing: '.08em',
            color: '#6a7d8e', margin: '0 0 24px',
          }}
        >
          PREVIEW · the same panel that lives inside the developer console
        </p>
        <Staking />
      </div>
    </div>
  )
}
