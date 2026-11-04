// The ceremony's flight (architecture §7.4), the Claude Design workbench's choreography: when a phone
// opens its camera, the phone whose code it is pointed at flies to the centre of the stage and tilts,
// the scanning phone flies over it with its viewfinder punched out, so the code is seen through the
// hole; once it has landed the lens opens (the camera sees the code), and when the scan has ended both
// fly back. Pure DOM and the Web Animations API; the transforms never touch the windows' positions.

export interface FlightParts {
  /** the scanning phone's window and its app frame */
  readonly scanWin: HTMLElement
  readonly scanFrame: HTMLIFrameElement
  /** the showing phone's window and frame; null when nobody shows a code */
  readonly showWin: HTMLElement | null
  readonly showFrame: HTMLIFrameElement | null
  readonly stage: HTMLElement
  /** the frame's CSS px per page px */
  readonly scale: number
  readonly reducedMotion: boolean
  /** the scanning phone is over the code: open the lens */
  readonly onLanded: () => void
}

export interface Flight {
  /** the scan ended: fly back and clean up */
  release(): void
}

const EASE = 'cubic-bezier(.35,0,.25,1)'

interface Rect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** an element inside a scaled frame, in page coordinates */
function inFrame(frame: HTMLIFrameElement, selector: string, scale: number): Rect | null {
  const el = frame.contentDocument?.querySelector(selector)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const f = frame.getBoundingClientRect()
  return { left: f.left + r.left * scale, top: f.top + r.top * scale, width: r.width * scale, height: r.height * scale }
}

const centre = (r: Rect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })

function arc(d: { x: number; y: number }, lift: number, tilt: number): Keyframe[] {
  return [0, 0.55, 1].map((t) => ({ transform: `translate(${d.x * t}px, ${d.y * t - Math.sin(t * Math.PI) * lift}px) rotate(${tilt * t}deg)` }))
}

/** a mask for the scanning window: everything but the viewfinder (an even-odd path punches the rounded square) */
function holeMask(win: Rect, hole: Rect): string {
  const r = 12
  const hx = Math.round(hole.left - win.left), hy = Math.round(hole.top - win.top)
  const hw = Math.round(hole.width), hh = Math.round(hole.height)
  const pw = Math.ceil(win.width), ph = Math.ceil(win.height)
  const path =
    `M${hx} ${hy + r}a${r} ${r} 0 0 1 ${r} -${r}h${hw - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${hh - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${hw - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}Z`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><path fill="#fff" fill-rule="evenodd" d="M0 0h${pw}v${ph}H0Z ${path}"/></svg>`
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`
}

function setMask(el: HTMLElement, mask: string | null, size: string | null) {
  const s = el.style as CSSStyleDeclaration & { webkitMask?: string; webkitMaskSize?: string; webkitMaskRepeat?: string }
  s.mask = mask ?? ''
  s.maskSize = size ?? ''
  s.maskRepeat = mask ? 'no-repeat' : ''
  s.webkitMask = mask ?? ''
  s.webkitMaskSize = size ?? ''
  s.webkitMaskRepeat = mask ? 'no-repeat' : ''
}

/** the apps draw their viewfinder and code a frame or two after the camera opened: wait for both, briefly */
function whenDrawn(scanFrame: HTMLIFrameElement, showFrame: HTMLIFrameElement | null, scale: number, until: number, cb: (viewfinder: Rect | null, code: Rect | null) => void): () => void {
  let raf = 0
  const look = () => {
    const viewfinder = inFrame(scanFrame, '[data-scan-viewport]', scale)
    const code = showFrame ? inFrame(showFrame, 'svg[role=img]', scale) : null
    if ((viewfinder && (code || !showFrame)) || performance.now() > until) cb(viewfinder, code)
    else raf = requestAnimationFrame(look)
  }
  look()
  return () => cancelAnimationFrame(raf)
}

export function startFlight(parts: FlightParts): Flight {
  const { scanWin, scanFrame, showWin, showFrame, stage, scale, reducedMotion, onLanded } = parts
  // no motion: the lens opens after a beat, as the eye would need
  if (reducedMotion) {
    const t = setTimeout(onLanded, 300)
    return { release: () => clearTimeout(t) }
  }
  let inner: Flight | null = null
  let released = false
  const stop = whenDrawn(scanFrame, showFrame, scale, performance.now() + 700, (viewfinder, code) => {
    if (released) return
    inner = fly({ scanWin, showWin, stage, viewfinder, code, onLanded })
  })
  return {
    release() {
      released = true
      stop()
      inner?.release()
    },
  }
}

function fly({ scanWin, showWin, stage, viewfinder, code, onLanded }: { scanWin: HTMLElement; showWin: HTMLElement | null; stage: HTMLElement; viewfinder: Rect | null; code: Rect | null; onLanded: () => void }): Flight {
  // nothing to fly to: the lens opens after a beat
  if (!viewfinder || !showWin || !code) {
    const t = setTimeout(onLanded, 900)
    return { release: () => clearTimeout(t) }
  }
  const st = stage.getBoundingClientRect()
  const cx = st.left + st.width / 2, cy = st.top + st.height / 2
  const ra = scanWin.getBoundingClientRect(), rb = showWin.getBoundingClientRect()
  const ac = centre(ra), bc = centre(rb), hc = centre(viewfinder), qc = centre(code)
  const tiltB = bc.x < ac.x ? 45 : -45
  // the showing window centres its code on the stage centre; the scanner lands with its hole exactly there
  const bd = { x: cx - qc.x, y: cy - qc.y }
  const ad = { x: cx - hc.x, y: cy - hc.y }
  setMask(scanWin, holeMask(ra, viewfinder), `${Math.ceil(ra.width)}px ${Math.ceil(ra.height)}px`)
  const anims = [
    showWin.animate(arc(bd, 70, tiltB), { duration: 950, easing: EASE, fill: 'forwards' }),
    scanWin.animate(arc(ad, 140, -tiltB), { duration: 2150, easing: EASE, fill: 'forwards' }),
  ]
  let landed = false
  const land = () => {
    if (landed) return
    landed = true
    onLanded()
  }
  anims[1]?.addEventListener('finish', land)
  // a safety net: the camera sees the code even if the animation never reports its end
  const net = setTimeout(land, 2600)
  let released = false
  return {
    release() {
      if (released) return
      released = true
      clearTimeout(net)
      // both transforms first: cancelling the flights resets them (CodeRabbit 503: the second window
      // read 'none' and jumped home)
      const els = [scanWin, showWin]
      const from = els.map((el) => {
        try {
          return getComputedStyle(el).transform
        } catch {
          return 'none'
        }
      })
      for (const a of anims) {
        try {
          a.cancel()
        } catch {
          /* already gone */
        }
      }
      els.forEach((el, i) => {
        setMask(el, null, null)
        const t = from[i] ?? 'none'
        const back = el.animate([{ transform: t }, { transform: 'none' }], { duration: 620, easing: EASE, fill: 'forwards' })
        back.addEventListener('finish', () => {
          try {
            back.cancel()
          } catch {
            /* already gone */
          }
        })
      })
    },
  }
}
