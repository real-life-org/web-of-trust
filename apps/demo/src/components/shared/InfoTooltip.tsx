import { HelpCircle } from 'lucide-react'
import { useState } from 'react'

interface InfoTooltipProps {
  content: string
}

export function InfoTooltip({ content }: InfoTooltipProps) {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onClick={() => setIsVisible(!isVisible)}
        className="p-1.5 ml-1 text-muted-foreground/70 hover:text-muted-foreground transition-colors"
        aria-label={content}
      >
        <HelpCircle size={16} />
      </button>
      {isVisible && (
        <div className="absolute z-10 w-64 p-3 bg-tooltip text-tooltip-foreground text-sm rounded-lg shadow-lg -top-2 left-8" role="tooltip">
          <div className="absolute -left-1 top-3 w-2 h-2 bg-tooltip transform rotate-45" />
          {content}
        </div>
      )}
    </div>
  )
}
