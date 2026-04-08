import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ShieldCheck, Pencil, UserPlus, Check, X } from 'lucide-react'
import { useSpaces, useContacts, useLocalIdentity } from '../hooks'
import { useAdapters, useIdentity } from '../context'
import { useLanguage } from '../i18n'
import { Tooltip } from '../components/ui/Tooltip'
import { Avatar } from '../components/shared'
import type { SpaceInfo, SpaceHandle, SpaceDocMeta } from '@web_of_trust/core'

import { ChatView, type ChatMessage } from '../components/spaces/ChatView'

interface SpaceDoc {
  messages: Record<string, ChatMessage>
}

export function SpaceDetail() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()
  const { getSpace, inviteMember, spaces } = useSpaces()
  const { replication } = useAdapters()
  const { activeContacts } = useContacts()
  const { did } = useIdentity()
  const localIdentity = useLocalIdentity()
  const [space, setSpace] = useState<SpaceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<Record<string, ChatMessage>>({})
  const handleRef = useRef<SpaceHandle<SpaceDoc> | null>(null)
  const [spaceMeta, setSpaceMeta] = useState<SpaceDocMeta>({})
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [selectedDids, setSelectedDids] = useState<Set<string>>(new Set())
  const [inviting, setInviting] = useState(false)

  useEffect(() => {
    if (!spaceId) return
    getSpace(spaceId).then(s => { setSpace(s); setLoading(false) })
  }, [spaceId, getSpace])

  useEffect(() => {
    if (!spaceId || !spaces || loading) return
    const current = spaces.find(s => s.id === spaceId)
    if (!current) {
      navigate('/spaces', { replace: true })
    } else {
      setSpace(current)
    }
  }, [spaceId, spaces, loading, navigate])

  useEffect(() => {
    if (!spaceId) return
    let cancelled = false
    let unsub: (() => void) | null = null

    async function open() {
      try {
        const handle = await replication.openSpace<SpaceDoc>(spaceId!)
        if (cancelled) { handle.close(); return }
        handleRef.current = handle
        const doc = handle.getDoc()
        setMessages(doc?.messages ?? {})
        setSpaceMeta(handle.getMeta())

        unsub = handle.onRemoteUpdate(() => {
          const updated = handle.getDoc()
          setMessages(updated?.messages ?? {})
          setSpaceMeta(handle.getMeta())
        })
      } catch (err) {
        console.warn('Failed to open space:', err)
      }
    }

    open()
    return () => {
      cancelled = true
      unsub?.()
      if (handleRef.current) { handleRef.current.close(); handleRef.current = null }
    }
  }, [spaceId, replication])

  const handleSendMessage = useCallback((text: string) => {
    if (!handleRef.current || !did || !text.trim()) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    handleRef.current.transact(doc => {
      if (!doc.messages) doc.messages = {} as Record<string, ChatMessage>
      doc.messages[id] = { id, author: did, text: text.trim(), ts: new Date().toISOString() }
    })
    const updated = handleRef.current.getDoc()
    setMessages(updated?.messages ?? {})
  }, [did])

  if (loading) return <div className="text-muted-foreground">{t.common.loading}</div>
  if (!space) return <div className="text-muted-foreground">{t.spaces.notFound}</div>

  const displayName = spaceMeta.name || space.name || t.spaces.unnamed

  const getMemberName = (memberDid: string) => {
    if (memberDid === did) return localIdentity?.profile?.name || t.identity.self
    const contact = activeContacts.find(c => c.did === memberDid)
    return contact?.name || memberDid.slice(-12)
  }

  const getMemberAvatar = (memberDid: string) => {
    if (memberDid === did) return localIdentity?.profile?.avatar
    return activeContacts.find(c => c.did === memberDid)?.avatar
  }

  return (
    <div className="flex flex-col -mb-4" style={{ height: 'calc(100vh - 8rem)' }}>
      {/* Header — like a chat app */}
      <div className="flex items-center gap-3 pb-3 shrink-0 border-b border-border">
        <button onClick={() => navigate('/spaces')} className="p-2 hover:bg-muted rounded-lg transition-colors" aria-label={t.aria.goBack}>
          <ArrowLeft size={20} />
        </button>
        <Link to={`/spaces/${spaceId}/edit`} className="flex-1 min-w-0 flex items-center gap-2 hover:opacity-80 transition-opacity">
          <Avatar name={displayName} avatar={spaceMeta.image || space.image} size="sm" />
          <div className="min-w-0">
            <h1 className="text-base font-bold text-foreground truncate">{displayName}</h1>
            <p className="text-xs text-muted-foreground/60">
              {space.members.length} {space.members.length === 1 ? t.common.personOne : t.common.personMany}
              <Tooltip content={t.spaces.encryptedBadge}>
                <ShieldCheck size={11} className="text-primary-500 inline ml-1 -mt-0.5" />
              </Tooltip>
            </p>
          </div>
        </Link>
        {activeContacts.filter(c => !space.members.includes(c.did)).length > 0 && (
          <button
            onClick={() => { setShowInviteDialog(true); setSelectedDids(new Set()) }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
          >
            <UserPlus size={14} />
            {t.spaces.inviteButton}
          </button>
        )}
      </div>

      {/* Chat — fills all remaining space */}
      <div className="flex-1 flex flex-col min-h-0 pt-3">
        <ChatView
          messages={messages}
          onSend={handleSendMessage}
          currentDid={did!}
          getMemberName={getMemberName}
          getMemberAvatar={getMemberAvatar}
        />
      </div>

      {/* Invite Dialog */}
      {showInviteDialog && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 animate-fade-in" role="dialog" aria-modal="true" onClick={() => !inviting && setShowInviteDialog(false)}>
          <div className="bg-background w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-lg font-semibold text-foreground">{t.spaces.inviteDialogTitle}</h3>
              <button onClick={() => !inviting && setShowInviteDialog(false)} className="p-2 text-muted-foreground/70 hover:text-muted-foreground rounded-lg transition-colors" aria-label={t.aria.closeDialog}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              <div className="space-y-1">
                {activeContacts.filter(c => !space.members.includes(c.did)).map(contact => {
                  const selected = selectedDids.has(contact.did)
                  return (
                    <button
                      key={contact.did}
                      onClick={() => setSelectedDids(prev => { const next = new Set(prev); if (next.has(contact.did)) next.delete(contact.did); else next.add(contact.did); return next })}
                      disabled={inviting}
                      className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors ${selected ? 'bg-primary-600/10 ring-1 ring-primary-600/30' : 'hover:bg-muted'} disabled:opacity-50`}
                    >
                      <Avatar name={contact.name} avatar={contact.avatar} size="xs" />
                      <span className="font-medium text-foreground truncate flex-1 text-left">{contact.name || contact.did.slice(-12)}</span>
                      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${selected ? 'bg-primary-600 border-primary-600' : 'border-border'}`}>
                        {selected && <Check size={14} className="text-white" />}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="px-5 py-4 border-t border-border">
              <button
                onClick={async () => {
                  if (selectedDids.size === 0) return
                  setInviting(true)
                  for (const contactDid of selectedDids) {
                    try { await inviteMember(spaceId!, contactDid) } catch {}
                  }
                  setInviting(false)
                  setSelectedDids(new Set())
                  setShowInviteDialog(false)
                }}
                disabled={selectedDids.size === 0 || inviting}
                className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <UserPlus size={18} />
                <span>{selectedDids.size > 0 ? fmt(t.spaces.inviteCount, { count: String(selectedDids.size) }) : t.spaces.inviteButton}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
