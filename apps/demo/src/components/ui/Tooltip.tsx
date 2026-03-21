import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react'

interface TooltipProps {
  content: string
  children: ReactNode
}

const TOOLTIP_WIDTH = 256 // w-64 = 16rem = 256px
const VIEWPORT_PADDING = 12
const GAP = 8

/**
 * Tooltip that stays within viewport bounds.
 * Shows on click (mobile) and hover (desktop).
 * Uses direct DOM manipulation for flicker-free positioning.
 */
export function Tooltip({ content, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const clickedOpen = useRef(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    const tooltip = tooltipRef.current
    if (!trigger || !tooltip) return

    const rect = trigger.getBoundingClientRect()
    const triggerCenter = rect.left + rect.width / 2
    let left = triggerCenter - TOOLTIP_WIDTH / 2
    const top = rect.bottom + GAP

    if (left < VIEWPORT_PADDING) left = VIEWPORT_PADDING
    if (left + TOOLTIP_WIDTH > window.innerWidth - VIEWPORT_PADDING) {
      left = window.innerWidth - VIEWPORT_PADDING - TOOLTIP_WIDTH
    }

    const arrowLeft = triggerCenter - left

    tooltip.style.position = 'fixed'
    tooltip.style.top = `${top}px`
    tooltip.style.left = `${left}px`
    tooltip.style.setProperty('--arrow-left', `${arrowLeft}px`)
  }, [])

  // Ref callback: fires the instant the tooltip DOM node mounts
  const tooltipCallbackRef = useCallback((node: HTMLDivElement | null) => {
    (tooltipRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    if (node) updatePosition()
  }, [updatePosition])

  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, updatePosition])

  // Close on outside click/touch
  useEffect(() => {
    if (!open) return
    const handler = (e: Event) => {
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        clickedOpen.current = false
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [open])

  const handleClick = useCallback(() => {
    if (clickedOpen.current) {
      clickedOpen.current = false
      setOpen(false)
    } else {
      clickedOpen.current = true
      setOpen(true)
    }
  }, [])

  const handleMouseEnter = useCallback(() => {
    if (!clickedOpen.current) setOpen(true)
  }, [])

  const handleMouseLeave = useCallback(() => {
    if (!clickedOpen.current) setOpen(false)
  }, [])

  return (
    <span className="relative inline-flex">
      <button
        ref={triggerRef}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-flex"
      >
        {children}
      </button>
      {open && (
        <div
          ref={tooltipCallbackRef}
          className="z-50 w-64 px-3 py-2 bg-tooltip text-tooltip-foreground text-xs rounded-lg shadow-lg animate-fade-in"
        >
          {content}
          <div
            className="absolute -top-1 w-2 h-2 bg-tooltip rotate-45"
            style={{ left: 'var(--arrow-left, 50%)', marginLeft: '-4px' }}
          />
        </div>
      )}
    </span>
  )
}
