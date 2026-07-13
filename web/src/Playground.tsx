import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { api, ApiError, type PlaygroundInfo, type PlaygroundMeta } from './api'

/* ============================================================
   Anonymous playground — the landing page "try the grid" box.
   No account: the gateway runs the prompt on a real community
   node and returns the receipt (GPU · city · tokens · cost).
   That meta line is the product pitch, so it gets the shine.
   ============================================================ */

interface Msg {
  role: 'user' | 'assistant'
  content: string
  meta?: PlaygroundMeta
}

const MONO: CSSProperties = { fontFamily: 'var(--mono)' }
const PROMPT_BUDGET = 1_800 // keep the sent history under the gateway's 2k char cap

// "RTX 4090 · Berlin, DE · 152 tok · $0.0003 · 1.8s"
function metaLine(m: PlaygroundMeta): string {
  const parts = [m.gpu]
  if (m.geo) parts.push(m.geo)
  parts.push(`${m.tokensOut} tok`)
  parts.push(`$${m.costUsd.toFixed(4)}`)
  parts.push(`${(m.latencyMs / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

function shareText(prompt: string, m: PlaygroundMeta): string {
  const where = m.geo ? ` in ${m.geo}` : ''
  return `Just ran "${prompt.slice(0, 80)}" on someone's ${m.gpu}${where} for $${m.costUsd.toFixed(4)} — decentralized AI compute on gpugrid.app`
}

export default function Playground() {
  const [info, setInfo] = useState<PlaygroundInfo | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [focused, setFocused] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api
      .playgroundInfo()
      .then((i) => {
        setInfo(i)
        setRemaining(i.remaining)
      })
      .catch(() => setInfo(null))
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs, busy])

  if (info === null) return null // disabled or unreachable → the section simply isn't there
  const outOfQuota = (remaining ?? 0) <= 0
  const paused = !info.budgetOkToday
  // Most recent answer's receipt — kept for the persistent "handled by" strip below.
  const lastMeta = [...msgs].reverse().find((m) => m.meta)?.meta ?? null

  const send = async () => {
    const prompt = input.trim()
    if (!prompt || busy || outOfQuota || paused) return
    setInput('')
    setNotice(null)
    setBusy(true)
    const history = [...msgs, { role: 'user' as const, content: prompt }]
    setMsgs(history)
    // Send as much recent history as fits the gateway's prompt budget.
    const outbox: { role: string; content: string }[] = []
    let chars = 0
    for (let i = history.length - 1; i >= 0; i--) {
      chars += history[i].content.length
      if (chars > PROMPT_BUDGET) break
      outbox.unshift({ role: history[i].role, content: history[i].content })
    }
    try {
      const r = await api.playgroundAsk(outbox)
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, meta: r.meta }])
      setRemaining(r.remaining)
    } catch (e) {
      const err = e as ApiError
      if (err.status === 429) setRemaining(0)
      setNotice(err.message)
    } finally {
      setBusy(false)
    }
  }

  const share = (i: number) => {
    const m = msgs[i]
    if (!m?.meta) return
    const prompt = msgs[i - 1]?.content ?? ''
    const text = shareText(prompt, m.meta)
    navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(i)
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1600)
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
  }

  return (
    <div
      style={{
        border: '1px solid rgba(140,158,176,.2)',
        borderRadius: 14,
        background: 'rgba(6,9,12,.92)',
        overflow: 'hidden',
        boxShadow: '0 24px 60px -20px rgba(0,0,0,.7)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* terminal chrome */}
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
        <span style={{ ...MONO, fontSize: 11, color: '#6a7d8e', marginLeft: 12, letterSpacing: '.06em' }}>
          live · {info.model}
        </span>
        <span style={{ ...MONO, marginLeft: 'auto', fontSize: 10, color: remaining === 0 ? '#e6a44b' : '#4d5d6c' }}>
          {remaining ?? info.perIpPerDay} / {info.perIpPerDay} free today
        </span>
      </div>

      {/* transcript */}
      <div
        ref={logRef}
        style={{ padding: '20px 20px 8px', minHeight: 280, maxHeight: 440, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 15 }}
      >
        {msgs.length === 0 && !busy && (
          <div style={{ ...MONO, fontSize: 12.5, lineHeight: 1.7, color: '#5d6f80' }}>
            <span style={{ color: '#5fd4e2' }}>$</span> ask anything — it runs on a real GPU from the grid,
            <br />
            <span style={{ opacity: 0 }}>$ </span>and you get the receipt: whose card, where, and the price.
            <br />
            <span style={{ color: '#4d5d6c' }}>↓ type your question in the box below and hit run</span>
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} style={{ ...MONO, fontSize: 13, lineHeight: 1.65, color: '#cdd9e4', whiteSpace: 'pre-wrap' }}>
              <span style={{ color: '#5fd4e2' }}>$ </span>
              {m.content}
            </div>
          ) : (
            <div key={i}>
              <div style={{ ...MONO, fontSize: 13, lineHeight: 1.7, color: '#9fb4c6', whiteSpace: 'pre-wrap' }}>{m.content}</div>
              {m.meta && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      ...MONO,
                      fontSize: 10.5,
                      letterSpacing: '.05em',
                      color: '#e6a44b',
                      border: '1px solid rgba(230,164,75,.28)',
                      background: 'rgba(230,164,75,.07)',
                      borderRadius: 6,
                      padding: '4px 9px',
                    }}
                  >
                    ⚡ {metaLine(m.meta)}
                  </span>
                  <button
                    onClick={() => share(i)}
                    className="tab-btn"
                    style={{
                      ...MONO,
                      fontSize: 10.5,
                      color: copied === i ? '#3fd07e' : '#6a7d8e',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: '4px 6px',
                      letterSpacing: '.05em',
                    }}
                  >
                    {copied === i ? 'copied ✓' : 'share ↗'}
                  </button>
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div style={{ ...MONO, fontSize: 12.5, color: '#5fd4e2' }}>
            <span style={{ animation: 'ggCue 1.2s ease-in-out infinite', display: 'inline-block' }}>▋</span>{' '}
            <span style={{ color: '#5d6f80' }}>routing to a free GPU…</span>
          </div>
        )}
        {notice && (
          <div style={{ ...MONO, fontSize: 12, lineHeight: 1.6, color: '#e6a44b' }}>
            ⚠ {notice}
            {outOfQuota && (
              <>
                {' — '}
                <a href="#/app" style={{ color: '#5fd4e2' }}>
                  sign up → {info.signupFreeRequests} free requests
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {/* input row */}
      <style>{`@keyframes ggInvite{0%,100%{box-shadow:0 0 0 0 rgba(95,212,226,0)}50%{box-shadow:0 0 0 4px rgba(95,212,226,.10)}}`}</style>
      <div style={{ padding: '12px 14px 14px', borderTop: '1px solid rgba(140,158,176,.1)' }}>
        {/* explicit "this is a chat box" affordance — a static hero must not read as a picture */}
        <div
          style={{
            ...MONO,
            fontSize: 10,
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
          }}
        >
          <span style={{ color: '#5fd4e2' }}>⌨ type your prompt</span>
          <span style={{ color: '#3d4a57' }}>· press Enter to run it on a real GPU</span>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {/* the whole field is a label → clicking anywhere focuses the input; a caret
              prefix + invite pulse + focus glow make it obviously a place to type */}
          <label
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              background: focused ? 'rgba(95,212,226,.06)' : 'rgba(140,158,176,.07)',
              border: `1px solid ${focused ? 'rgba(95,212,226,.65)' : 'rgba(140,158,176,.28)'}`,
              borderRadius: 8,
              padding: '0 13px',
              cursor: busy || outOfQuota || paused ? 'default' : 'text',
              boxShadow: focused ? '0 0 0 3px rgba(95,212,226,.14)' : 'none',
              animation: !focused && !input && !busy && !outOfQuota && !paused ? 'ggInvite 2.4s ease-in-out infinite' : 'none',
              transition: 'border .2s, box-shadow .2s, background .2s',
            }}
          >
            <span style={{ ...MONO, color: focused ? '#5fd4e2' : '#4d5d6c', fontSize: 15, fontWeight: 700 }}>&gt;</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              disabled={busy || outOfQuota || paused}
              placeholder={
                paused
                  ? 'free tier is resting — back tomorrow'
                  : outOfQuota
                    ? `daily limit reached — sign up for ${info.signupFreeRequests} more`
                    : 'type your question here…  e.g. explain quantum computing in one sentence'
              }
              maxLength={1200}
              style={{
                ...MONO,
                flex: 1,
                fontSize: 13,
                color: '#eef4fb',
                background: 'transparent',
                border: 'none',
                padding: '12px 0',
                outline: 'none',
                caretColor: '#5fd4e2',
                width: '100%',
              }}
            />
          </label>
          <button
            onClick={send}
            disabled={busy || outOfQuota || paused || !input.trim()}
            className="btn-solid"
            style={{
              ...MONO,
              fontSize: 12.5,
              letterSpacing: '.04em',
              color: '#06080b',
              background: busy || outOfQuota || paused ? 'rgba(140,158,176,.4)' : '#e8f0f8',
              border: 'none',
              borderRadius: 8,
              padding: '0 18px',
              cursor: busy || outOfQuota || paused || !input.trim() ? 'default' : 'pointer',
              transition: 'filter .2s',
            }}
          >
            run ↵
          </button>
        </div>
      </div>

      {/* persistent receipt strip — always shows which node handled the last job,
          so the "your prompt ran on a real GPU" claim is visible, not just in-line */}
      <div
        style={{
          borderTop: '1px solid rgba(140,158,176,.1)',
          background: 'rgba(12,17,22,.5)',
          padding: '11px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          ...MONO,
          fontSize: 10.5,
          letterSpacing: '.04em',
        }}
      >
        <span style={{ color: '#4d5d6c', textTransform: 'uppercase' }}>handled by</span>
        {lastMeta ? (
          <span style={{ color: '#9fb4c6' }}>
            <span style={{ color: '#e6a44b' }}>⚡ {lastMeta.gpu}</span>
            {lastMeta.geo ? ` · ${lastMeta.geo}` : ''} · node {lastMeta.node.slice(0, 10)}… · {lastMeta.tokensOut} tok · $
            {lastMeta.costUsd.toFixed(4)} · {(lastMeta.latencyMs / 1000).toFixed(1)}s
          </span>
        ) : (
          <span style={{ color: '#3d4a57' }}>
            a real community GPU — you'll see the exact card, city, node id &amp; price here once you ask
          </span>
        )}
      </div>
    </div>
  )
}
