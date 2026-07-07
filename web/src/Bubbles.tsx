import { useEffect, useRef } from 'react'
import { scroll } from './scroll'

/* Rising bubbles + deep bioluminescence. On the landing (`tone='auto'`) the color
   tracks scroll depth: pale near the surface, cyan in the twilight zone, orange
   embers near the molten core. The consoles pin a fixed tone (cyan = developer,
   ember = provider) so the same particles drift as ambient atmosphere. */
export default function Bubbles({
  tone = 'auto',
  count = 60,
  z = 4,
  opacity = 1,
}: {
  tone?: 'auto' | 'cyan' | 'ember'
  count?: number
  z?: number
  opacity?: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    let W = 0
    let H = 0
    let raf = 0
    const resize = () => {
      const DPR = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth
      H = window.innerHeight
      cv.width = W * DPR
      cv.height = H * DPR
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)
    const ps = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 2.1 + 0.6,
      vy: Math.random() * 0.5 + 0.16, // rise speed
      amp: Math.random() * 0.7 + 0.2, // horizontal wobble
      ph: Math.random() * 6.283,
      tw: Math.random() * 6.283, // twinkle phase
      o: Math.random() * 0.32 + 0.1,
    }))
    let tt = 0
    const draw = () => {
      ctx.clearRect(0, 0, W, H)
      tt += 0.016
      // pinned tone overrides the depth-driven color
      let biolum: number
      let ember: number
      if (tone === 'cyan') {
        biolum = 1
        ember = 0
      } else if (tone === 'ember') {
        biolum = 0
        ember = 1
      } else {
        const depth = scroll.progress // 0 surface .. 1 abyss
        biolum = Math.max(0, (depth - 0.45) / 0.55) // cyan glow in the twilight zone
        ember = Math.max(0, (depth - 0.7) / 0.3) // orange embers near the core
      }
      for (const p of ps) {
        p.y -= p.vy
        p.x += Math.sin(tt * 0.6 + p.ph) * p.amp * 0.5
        if (p.y < -6) {
          p.y = H + 6
          p.x = Math.random() * W
        }
        const twinkle = biolum > 0 ? 0.55 + 0.45 * Math.sin(tt * 2.2 + p.tw) : 1
        const alpha = p.o * twinkle
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, 6.283)
        if (ember > 0.05) {
          // rising embers from the molten core
          ctx.fillStyle = `rgba(238,150,68,${alpha})`
          ctx.shadowColor = 'rgba(236,132,48,.95)'
          ctx.shadowBlur = 7 * ember
        } else if (biolum > 0.12) {
          ctx.fillStyle = `rgba(110,226,236,${alpha})`
          ctx.shadowColor = 'rgba(95,212,226,.9)'
          ctx.shadowBlur = 5 * biolum
        } else {
          ctx.fillStyle = `rgba(176,214,232,${alpha})`
          ctx.shadowBlur = 0
        }
        ctx.fill()
      }
      ctx.shadowBlur = 0
      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [tone, count])
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, zIndex: z, pointerEvents: 'none', display: 'block', opacity }} />
}
