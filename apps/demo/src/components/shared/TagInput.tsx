import { useState, useRef, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'

type ChipColor = 'green' | 'amber' | 'blue'

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  color?: ChipColor
}

const colorClasses: Record<ChipColor, { chip: string; x: string }> = {
  green: { chip: 'bg-success/15 text-success', x: 'text-success hover:text-success' },
  amber: { chip: 'bg-amber-100 text-amber-800', x: 'text-amber-500 hover:text-amber-700' },
  blue: { chip: 'bg-primary-100 text-primary-800', x: 'text-primary-500 hover:text-primary-700' },
}

export function TagInput({ tags, onChange, placeholder = 'Tag eingeben, Enter zum Bestätigen', color = 'green' }: TagInputProps) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { chip, x } = colorClasses[color]

  const addTag = (value: string) => {
    const trimmed = value.trim().replace(/,+$/, '').trim()
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed])
    }
    setInput('')
  }

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index))
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && input === '' && tags.length > 0) {
      removeTag(tags.length - 1)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    if (value.endsWith(',')) {
      addTag(value)
    } else {
      setInput(value)
    }
  }

  return (
    <div
      className="flex flex-wrap gap-1.5 min-h-[42px] w-full px-3 py-2 bg-card border border-border rounded-lg focus-within:ring-2 focus-within:ring-primary-500 cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag, i) => (
        <span
          key={i}
          className={`inline-flex items-center gap-1 px-2 py-0.5 text-sm rounded-md ${chip}`}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(i) }}
            className={`p-0.5 -m-0.5 transition-colors ${x}`}
            aria-label={`${tag} entfernen`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) addTag(input) }}
        className="flex-1 min-w-[120px] outline-none text-sm bg-transparent text-foreground placeholder-muted-foreground"
        placeholder={tags.length === 0 ? placeholder : ''}
      />
    </div>
  )
}
