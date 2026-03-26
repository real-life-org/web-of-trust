import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, UserPlus, UserMinus, Lock, ShieldCheck, X, Check, Pencil, ImagePlus, Trash2, LogOut } from 'lucide-react'
import { useSpaces, useContacts, useLocalIdentity } from '../hooks'
import { useAdapters, useIdentity } from '../context'
import { useLanguage } from '../i18n'
import { Tooltip } from '../components/ui/Tooltip'
import { Avatar } from '../components/shared'
import type { SpaceInfo, SpaceHandle, SpaceDocMeta } from '@web.of.trust/core'

interface SpaceDoc {
  notes: string
}

const MAX_IMAGE_BYTES = 150 * 1024 // 150 KB

export function SpaceDetail() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()
  const { getSpace, updateSpace, inviteMember, removeMember, leaveSpace, spaces } = useSpaces()
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

  // Space metadata state
  const [spaceMeta, setSpaceMeta] = useState<SpaceDocMeta>({})
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState('')
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionValue, setDescriptionValue] = useState('')
  const [imageError, setImageError] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (!spaceId) return
    getSpace(spaceId).then(s => { setSpace(s); setLoading(false) })
  }, [spaceId, getSpace])

  // Keep space info in sync with watchSpaces
  useEffect(() => {
    if (!spaceId || !spaces || loading) return
    const current = spaces.find(s => s.id === spaceId)
    if (!current) {
      navigate('/spaces', { replace: true })
    } else {
      setSpace(current)
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
        setSpaceMeta(handle.getMeta())

        unsub = handle.onRemoteUpdate(() => {
          const updated = handle.getDoc()
          setNotes(updated?.notes ?? '')
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
      }, { stream: true })
    }
  }, [])

  // --- Name editing ---
  const startEditingName = () => {
    setNameValue(spaceMeta.name || space?.name || '')
    setEditingName(true)
  }

  const saveName = async () => {
    const trimmed = nameValue.trim()
    if (!trimmed || !spaceId) return
    setEditingName(false)
    await updateSpace(spaceId, { name: trimmed })
    setSpaceMeta(prev => ({ ...prev, name: trimmed }))
  }

  const cancelEditName = () => {
    setEditingName(false)
  }

  // --- Description editing ---
  const startEditingDescription = () => {
    setDescriptionValue(spaceMeta.description || '')
    setEditingDescription(true)
  }

  const saveDescription = async () => {
    if (!spaceId) return
    setEditingDescription(false)
    await updateSpace(spaceId, { description: descriptionValue.trim() })
    setSpaceMeta(prev => ({ ...prev, description: descriptionValue.trim() }))
  }

  // --- Image upload ---
  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !spaceId) return
    setImageError(null)

    if (file.size > MAX_IMAGE_BYTES) {
      setImageError(t.spaces.imageTooLarge)
      return
    }

    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result as string
      await updateSpace(spaceId, { image: dataUrl })
      setSpaceMeta(prev => ({ ...prev, image: dataUrl }))
    }
    reader.readAsDataURL(file)
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }

  const handleImageRemove = async () => {
    if (!spaceId) return
    await updateSpace(spaceId, { image: '' })
    setSpaceMeta(prev => ({ ...prev, image: '' }))
  }

  const refreshSpace = async () => {
    if (!spaceId) return
    const s = await getSpace(spaceId)
    setSpace(s)
  }

  if (loading) return <div className="text-muted-foreground">{t.common.loading}</div>
  if (!space) return <div className="text-muted-foreground">{t.spaces.notFound}</div>

  const isCreator = space.members[0] === did
  const invitableContacts = activeContacts.filter(c => !space.members.includes(c.did))
  const displayName = spaceMeta.name || space.name || t.spaces.unnamed

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

  const handleLeave = async () => {
    if (!space) return
    setLeaving(true)
    try {
      await leaveSpace(space.id)
      navigate('/spaces')
    } catch (err) {
      setError(err instanceof Error ? err.message : t.spaces.leaveFailed)
      setLeaving(false)
      setShowLeaveConfirm(false)
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
      {/* Header: Back + Name + Badge */}
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/spaces')} className="p-2 hover:bg-muted rounded-lg transition-colors" aria-label={t.aria.goBack}>
            <ArrowLeft size={20} />
          </button>

          {editingName ? (
            <input
              autoFocus
              value={nameValue}
              onChange={e => setNameValue(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => {
                if (e.key === 'Enter') saveName()
                if (e.key === 'Escape') cancelEditName()
              }}
              className="text-2xl font-bold text-foreground bg-transparent border-b-2 border-primary-500 outline-none flex-1 min-w-0"
            />
          ) : (
            <button
              onClick={startEditingName}
              className="flex items-center gap-2 group min-w-0"
            >
              <h1 className="text-2xl font-bold text-foreground truncate">{displayName}</h1>
              <Pencil size={14} className="text-muted-foreground/50 group-hover:text-muted-foreground transition-colors shrink-0" />
            </button>
          )}

          <Tooltip content={t.spaces.encryptedBadge}>
            <ShieldCheck size={16} className="text-primary-500 shrink-0" />
          </Tooltip>
        </div>
      </div>

      {/* Space Image + Description */}
      <div className="flex gap-4 items-start">
        {/* Image */}
        <div className="shrink-0">
          {spaceMeta.image ? (
            <div className="relative group">
              <img
                src={spaceMeta.image}
                alt={displayName}
                className="w-20 h-20 rounded-xl object-cover border border-border"
              />
              <button
                onClick={handleImageRemove}
                className="absolute -top-2 -right-2 p-1 bg-destructive text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={t.spaces.imageRemove}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ) : (
            <label className="w-20 h-20 rounded-xl border-2 border-dashed border-border hover:border-primary-400 flex items-center justify-center cursor-pointer transition-colors">
              <ImagePlus size={20} className="text-muted-foreground/50" />
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
            </label>
          )}
          {imageError && <p className="text-xs text-destructive mt-1">{imageError}</p>}
        </div>

        {/* Description */}
        <div className="flex-1 min-w-0">
          {editingDescription ? (
            <textarea
              autoFocus
              value={descriptionValue}
              onChange={e => setDescriptionValue(e.target.value)}
              onBlur={saveDescription}
              onKeyDown={e => {
                if (e.key === 'Escape') setEditingDescription(false)
              }}
              placeholder={t.spaces.descriptionPlaceholder}
              className="w-full min-h-[60px] p-2 bg-card border border-border rounded-lg text-sm text-foreground placeholder-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
            />
          ) : (
            <button
              onClick={startEditingDescription}
              className="w-full text-left group"
            >
              {spaceMeta.description ? (
                <p className="text-sm text-muted-foreground">{spaceMeta.description}</p>
              ) : (
                <p className="text-sm text-muted-foreground/50 italic">{t.spaces.descriptionPlaceholder}</p>
              )}
              <Pencil size={12} className="text-muted-foreground/30 group-hover:text-muted-foreground mt-1 transition-colors" />
            </button>
          )}
        </div>
      </div>

      {/* Shared Notes */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-2">{t.spaces.notesHeading}</h2>
        <textarea
          ref={textareaRef}
          value={notes}
          onChange={handleNotesChange}
          placeholder={t.spaces.notesPlaceholder}
          className="w-full min-h-[200px] p-4 bg-card border border-border rounded-xl text-sm text-foreground placeholder-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent resize-y"
        />
      </div>

      {/* Members */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-foreground">
            {fmt(t.spaces.membersHeading, { count: String(space.members.length) })}
          </h2>
          {invitableContacts.length > 0 && (
            <button
              onClick={() => { setShowInviteDialog(true); setSelectedDids(new Set()); setError(null) }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
            >
              <UserPlus size={16} />
              {t.spaces.inviteButton}
            </button>
          )}
        </div>

        {error && <p className="text-sm text-destructive mb-3 whitespace-pre-line">{error}</p>}

        <div className="space-y-2">
          {space.members.map(memberDid => {
            const member = getMemberInfo(memberDid)
            return (
            <div key={memberDid} className="flex items-center justify-between bg-card border border-border rounded-xl px-4 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar name={member.name} avatar={member.avatar} size="xs" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{member.name}</p>
                    {memberDid === space.members[0] && <span className="text-xs text-primary-400 bg-primary-500/15 px-1.5 py-0.5 rounded">Admin</span>}
                    {member.isSelf && <span className="text-xs text-muted-foreground/70">{t.publicProfile.youSuffix}</span>}
                  </div>
                  <p className="text-xs text-muted-foreground/70 font-mono truncate max-w-[200px]">{memberDid}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Lock size={14} className="text-primary-500" />
                {isCreator && memberDid !== did && (
                  <button
                    onClick={() => handleRemove(memberDid)}
                    className="p-2 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                    aria-label={t.aria.removeMember}
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
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 animate-fade-in" role="dialog" aria-modal="true" aria-labelledby="invite-dialog-title" onClick={() => !inviting && setShowInviteDialog(false)}>
          <div className="bg-background w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 id="invite-dialog-title" className="text-lg font-semibold text-foreground">{t.spaces.inviteDialogTitle}</h3>
              <button onClick={() => !inviting && setShowInviteDialog(false)} className="p-2 text-muted-foreground/70 hover:text-muted-foreground rounded-lg transition-colors" aria-label={t.aria.closeDialog}>
                <X size={20} />
              </button>
            </div>

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {invitableContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t.spaces.noContactsToInvite}</p>
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
                          selected ? 'bg-primary-600/10 ring-1 ring-primary-600/30' : 'hover:bg-muted'
                        } disabled:opacity-50`}
                      >
                        <Avatar name={contact.name} avatar={contact.avatar} size="xs" />
                        <span className="font-medium text-foreground truncate flex-1 text-left">
                          {contact.name || contact.did.slice(-12)}
                        </span>
                        <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                          selected ? 'bg-primary-600 border-primary-600' : 'border-border'
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
              <div className="px-5 py-4 border-t border-border">
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

      {/* Leave Space */}
      <div className="pt-4 border-t border-border">
        {!showLeaveConfirm ? (
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-destructive/80 hover:text-destructive hover:bg-destructive/10 rounded-xl transition-colors w-full"
          >
            <LogOut size={16} />
            {t.spaces.leaveButton}
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-foreground/80">{t.spaces.leaveConfirm}</p>
            <div className="flex gap-2">
              <button
                onClick={handleLeave}
                disabled={leaving}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-destructive hover:bg-destructive/90 rounded-xl transition-colors disabled:opacity-50"
              >
                {leaving ? t.common.loading : t.spaces.leaveConfirmButton}
              </button>
              <button
                onClick={() => setShowLeaveConfirm(false)}
                disabled={leaving}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-foreground/70 bg-muted hover:bg-muted/80 rounded-xl transition-colors disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="text-xs text-muted-foreground/70 space-y-1">
        <p>{t.spaces.createdAt}: {new Date(space.createdAt).toLocaleDateString()}</p>
        <p>ID: {space.id.slice(0, 8)}...</p>
      </div>
    </div>
  )
}
