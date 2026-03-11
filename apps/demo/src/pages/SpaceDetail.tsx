import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, UserPlus, UserMinus, Lock, ShieldCheck, X, Check } from 'lucide-react'
import { useSpaces, useContacts, useLocalIdentity } from '../hooks'
import { useAdapters, useIdentity } from '../context'
import { useLanguage } from '../i18n'
import { Tooltip } from '../components/ui/Tooltip'
import { Avatar } from '../components/shared'
import type { SpaceInfo, SpaceHandle } from '@real-life/wot-core'

interface SpaceDoc {
  notes: string
}

export function SpaceDetail() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()
  const { getSpace, inviteMember, removeMember, spaces } = useSpaces()
  const { replication } = useAdapters()
  const { activeContacts } = useContacts()
  const { did } = useIdentity()
  const localIdentity = useLocalIdentity()
  const [space, setSpace] = useState<SpaceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [selectedDids, setSelectedDids] = useState<Set<string>>(new Set())
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const handleRef = useRef<SpaceHandle<SpaceDoc> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!spaceId) return
    getSpace(spaceId).then(s => { setSpace(s); setLoading(false) })
  }, [spaceId, getSpace])

  // Navigate away if we were removed from this space
  useEffect(() => {
    if (!spaceId || !spaces || loading) return
    const stillExists = spaces.some(s => s.id === spaceId)
    if (!stillExists) {
      navigate('/spaces', { replace: true })
    }
  }, [spaceId, spaces, loading, navigate])

  // Open space handle and subscribe to remote updates
  useEffect(() => {
    if (!spaceId) return
    let cancelled = false
    let unsub: (() => void) | null = null

    async function open() {
      try {
        const handle = await replication.openSpace<SpaceDoc>(spaceId!)
        if (cancelled) {
          handle.close()
          return
        }
        handleRef.current = handle
        const doc = handle.getDoc()
        setNotes(doc?.notes ?? '')

        unsub = handle.onRemoteUpdate(() => {
          const updated = handle.getDoc()
          setNotes(updated?.notes ?? '')
        })
      } catch (err) {
        console.warn('Failed to open space:', err)
      }
    }

    open()
    return () => {
      cancelled = true
      unsub?.()
      if (handleRef.current) {
        handleRef.current.close()
        handleRef.current = null
      }
    }
  }, [spaceId, replication])

  const handleNotesChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setNotes(value)
    if (handleRef.current) {
      handleRef.current.transact(doc => {
        doc.notes = value
      })
    }
  }, [])

  const refreshSpace = async () => {
    if (!spaceId) return
    const s = await getSpace(spaceId)
    setSpace(s)
  }

  if (loading) return <div className="text-slate-500">{t.common.loading}</div>
  if (!space) return <div className="text-slate-500">{t.spaces.notFound}</div>

  const isCreator = space.members[0] === did
  const invitableContacts = activeContacts.filter(c => !space.members.includes(c.did))

  const toggleSelected = (contactDid: string) => {
    setSelectedDids(prev => {
      const next = new Set(prev)
      if (next.has(contactDid)) next.delete(contactDid)
      else next.add(contactDid)
      return next
    })
  }

  const handleInviteSelected = async () => {
    if (selectedDids.size === 0) return
    setInviting(true)
    setError(null)
    const errors: string[] = []
    for (const contactDid of selectedDids) {
      try {
        await inviteMember(space.id, contactDid)
      } catch (err) {
        const msg = err instanceof Error ? err.message : ''
        const name = activeContacts.find(c => c.did === contactDid)?.name || contactDid.slice(-12)
        if (msg === 'NO_ENCRYPTION_KEY') {
          errors.push(`${name}: ${t.spaces.errorNoEncryptionKey}`)
        } else {
          errors.push(`${name}: ${t.spaces.errorInviteFailed}`)
        }
      }
    }
    await refreshSpace()
    setInviting(false)
    setSelectedDids(new Set())
    setShowInviteDialog(false)
    if (errors.length > 0) setError(errors.join('\n'))
  }

  const handleRemove = async (memberDid: string) => {
    setError(null)
    try {
      await removeMember(space.id, memberDid)
      await refreshSpace()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.spaces.errorRemoveFailed)
    }
  }

  const getMemberInfo = (memberDid: string) => {
    const isSelf = memberDid === did
    if (isSelf) return { name: localIdentity?.profile?.name || t.identity.self, ...(localIdentity?.profile?.avatar ? { avatar: localIdentity.profile.avatar } : {}), isSelf, isContact: false }
    const contact = activeContacts.find(c => c.did === memberDid)
    return { name: contact?.name || memberDid.slice(-12), ...(contact?.avatar ? { avatar: contact.avatar } : {}), isSelf, isContact: !!contact }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/spaces')} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-2xl font-bold text-slate-900">{space.name || t.spaces.unnamed}</h1>
          <Tooltip content={t.spaces.encryptedBadge}>
            <ShieldCheck size={16} className="text-emerald-500" />
          </Tooltip>
        </div>
      </div>

      {/* Shared Notes */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">{t.spaces.notesHeading}</h2>
        <textarea
          ref={textareaRef}
          value={notes}
          onChange={handleNotesChange}
          placeholder={t.spaces.notesPlaceholder}
          className="w-full min-h-[200px] p-4 border border-slate-200 rounded-xl text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
        />
      </div>

      {/* Members */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {fmt(t.spaces.membersHeading, { count: String(space.members.length) })}
          </h2>
          {isCreator && invitableContacts.length > 0 && (
            <button
              onClick={() => { setShowInviteDialog(true); setSelectedDids(new Set()); setError(null) }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
            >
              <UserPlus size={16} />
              {t.spaces.inviteButton}
            </button>
          )}
        </div>

        {error && <p className="text-sm text-red-600 mb-3 whitespace-pre-line">{error}</p>}

        <div className="space-y-2">
          {space.members.map(memberDid => {
            const member = getMemberInfo(memberDid)
            return (
            <div key={memberDid} className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={member.name} avatar={member.avatar} size="xs" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-slate-900">{member.name}</p>
                    {member.isSelf && <span className="text-xs text-slate-400">{t.publicProfile.youSuffix}</span>}
                  </div>
                  <p className="text-xs text-slate-400 font-mono truncate max-w-[200px]">{memberDid}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Lock size={14} className="text-emerald-500" />
                {isCreator && memberDid !== did && (
                  <button
                    onClick={() => handleRemove(memberDid)}
                    className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title={t.spaces.removeButton}
                  >
                    <UserMinus size={16} />
                  </button>
                )}
              </div>
            </div>
            )
          })}
        </div>
      </div>

      {/* Invite Dialog */}
      {showInviteDialog && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 animate-fade-in" onClick={() => !inviting && setShowInviteDialog(false)}>
          <div className="bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-900">{t.spaces.inviteDialogTitle}</h3>
              <button onClick={() => !inviting && setShowInviteDialog(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg transition-colors">
                <X size={20} />
              </button>
            </div>

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {invitableContacts.length === 0 ? (
                <p className="text-sm text-slate-500 py-4 text-center">{t.spaces.noContactsToInvite}</p>
              ) : (
                <div className="space-y-1">
                  {invitableContacts.map(contact => {
                    const selected = selectedDids.has(contact.did)
                    return (
                      <button
                        key={contact.did}
                        onClick={() => toggleSelected(contact.did)}
                        disabled={inviting}
                        className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-colors ${
                          selected ? 'bg-primary-50 ring-1 ring-primary-200' : 'hover:bg-slate-50'
                        } disabled:opacity-50`}
                      >
                        <Avatar name={contact.name} avatar={contact.avatar} size="xs" />
                        <span className="font-medium text-slate-900 truncate flex-1 text-left">
                          {contact.name || contact.did.slice(-12)}
                        </span>
                        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                          selected ? 'bg-primary-600 border-primary-600' : 'border-slate-300'
                        }`}>
                          {selected && <Check size={14} className="text-white" />}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            {invitableContacts.length > 0 && (
              <div className="px-5 py-4 border-t border-slate-200">
                <button
                  onClick={handleInviteSelected}
                  disabled={selectedDids.size === 0 || inviting}
                  className="w-full py-2.5 bg-primary-600 hover:bg-primary-700 text-white font-medium rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {inviting ? (
                    <span>{t.common.loading}</span>
                  ) : (
                    <>
                      <UserPlus size={18} />
                      <span>{selectedDids.size > 0
                        ? fmt(t.spaces.inviteCount, { count: String(selectedDids.size) })
                        : t.spaces.inviteButton
                      }</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="text-xs text-slate-400 space-y-1">
        <p>{t.spaces.createdAt}: {new Date(space.createdAt).toLocaleDateString()}</p>
        <p>ID: {space.id.slice(0, 8)}...</p>
      </div>
    </div>
  )
}
