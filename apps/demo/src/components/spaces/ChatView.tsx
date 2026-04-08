import { useState, useRef, useEffect, useMemo } from 'react'
import { Send, MessageCircle } from 'lucide-react'
import { Avatar } from '../shared'
import { useLanguage } from '../../i18n'

export interface ChatMessage {
  id: string
  author: string
  text: string
  ts: string
}

interface ChatViewProps {
  messages: Record<string, ChatMessage>
  onSend: (text: string) => void
  currentDid: string
  getMemberName: (did: string) => string
  getMemberAvatar?: (did: string) => string | undefined
}

function formatTime(ts: string): string {
  const date = new Date(ts)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'jetzt'
  if (diffMin < 60) return `${diffMin}m`

  const isToday = date.toDateString() === now.toDateString()
  if (isToday) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return date.toLocaleDateString([], { day: 'numeric', month: 'short' }) +
    ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function ChatView({ messages, onSend, currentDid, getMemberName, getMemberAvatar }: ChatViewProps) {
  const { t } = useLanguage()
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const sorted = useMemo(() =>
    Object.values(messages).sort((a, b) => a.ts.localeCompare(b.ts)),
    [messages]
  )

  // Auto-scroll when new messages arrive
  useEffect(() => {
    if (sorted.length > prevCountRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
    prevCountRef.current = sorted.length
  }, [sorted.length])

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground/50 gap-3 py-12">
          <MessageCircle size={40} strokeWidth={1.5} />
          <p className="text-sm">{t.spaces.chatEmpty}</p>
        </div>

        <div className="flex items-center gap-2 pt-3 border-t border-border">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t.spaces.chatPlaceholder}
            className="flex-1 px-4 py-2.5 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="p-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/80 transition-colors disabled:opacity-30"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    )
  }

  // Group consecutive messages from same author
  let lastAuthor = ''

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={listRef} className="flex-1 overflow-y-auto space-y-1 pb-3">
        {sorted.map((msg) => {
          const isOwn = msg.author === currentDid
          const showAuthor = msg.author !== lastAuthor
          lastAuthor = msg.author

          return (
            <div key={msg.id} className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'}`}>
              {showAuthor && (
                <div className={`flex items-center gap-1.5 mt-3 mb-0.5 ${isOwn ? 'flex-row-reverse' : ''}`}>
                  <Avatar
                    name={isOwn ? t.spaces.chatYou : getMemberName(msg.author)}
                    avatar={getMemberAvatar?.(msg.author)}
                    size="xs"
                  />
                  <span className="text-xs text-muted-foreground/70 font-medium">
                    {isOwn ? t.spaces.chatYou : getMemberName(msg.author)}
                  </span>
                  <span className="text-xs text-muted-foreground/40">
                    {formatTime(msg.ts)}
                  </span>
                </div>
              )}
              <div className={`max-w-[80%] px-3 py-1.5 rounded-2xl text-sm whitespace-pre-wrap break-words ${
                isOwn
                  ? 'bg-primary text-primary-foreground rounded-br-md'
                  : 'bg-muted text-foreground rounded-bl-md'
              }`}>
                {msg.text}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-center gap-2 pt-3 border-t border-border">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.spaces.chatPlaceholder}
          className="flex-1 px-4 py-2.5 bg-card border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="p-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/80 transition-colors disabled:opacity-30"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  )
}
