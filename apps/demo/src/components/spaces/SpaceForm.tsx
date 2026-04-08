import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ImagePlus, Trash2, UserPlus, UserMinus, Lock, Check, X, LogOut } from 'lucide-react'
import { useSpaces, useContacts, useLocalIdentity } from '../../hooks'
import { useIdentity } from '../../context'
import { useLanguage } from '../../i18n'
import { Avatar } from '../shared'

function resizeImage(file: File, maxSize: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = maxSize
      canvas.height = maxSize
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('Canvas not supported')); return }
      const srcSize = Math.min(img.width, img.height)
      const srcX = (img.width - srcSize) / 2
      const srcY = (img.height - srcSize) / 2
      ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, maxSize, maxSize)
      resolve(canvas.toDataURL('image/webp', 0.8))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')) }
    img.src = url
  })
}

interface SpaceFormProps {
  mode: 'create' | 'edit'
}

export function SpaceForm({ mode }: SpaceFormProps) {
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()
  const { spaceId } = useParams<{ spaceId: string }>()
  const { createSpace, getSpace, updateSpace, inviteMember, removeMember, leaveSpace, spaces } = useSpaces()
  const { activeContacts } = useContacts()
  const { did } = useIdentity()
  const localIdentity = useLocalIdentity()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [image, setImage] = useState<string | undefined>(undefined)
  const [imageError, setImageError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(mode === 'edit')
  const [space, setSpace] = useState<{ members: string[] } | null>(null)
  const [showInviteDialog, setShowInviteDialog] = useState(false)
  const [selectedDids, setSelectedDids] = useState<Set<string>>(new Set())
  const [inviting, setInviting] = useState(false)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)
  const [leaving, setLeaving] = useState(false)

  // Load existing space data when editing
  useEffect(() => {
    if (mode !== 'edit' || !spaceId) return
    getSpace(spaceId).then(s => {
      if (s) {
        setName(s.name || '')
        setDescription(s.description || '')
        setImage(s.image)
        setSpace(s)
      }
      setLoading(false)
    })
  }, [mode, spaceId, getSpace])

  // Keep space in sync
  useEffect(() => {
    if (mode !== 'edit' || !spaceId || !spaces) return
    const current = spaces.find(s => s.id === spaceId)
    if (current) setSpace(current)
  }, [mode, spaceId, spaces])

  // Autosave in edit mode (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const autoSave = useCallback(() => {
    if (mode !== 'edit' || !spaceId || !name.trim()) return
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      updateSpace(spaceId, {
        name: name.trim(),
        description: description.trim(),
        image: image || '',
      }).catch(() => {})
    }, 800)
  }, [mode, spaceId, name, description, image, updateSpace])

  useEffect(() => { autoSave() }, [name, description, image, autoSave])
  useEffect(() => () => clearTimeout(saveTimerRef.current), [])

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    setImageError(null)

    try {
      const base64 = await resizeImage(file, 200)
      setImage(base64)
    } catch {
      setImageError(t.spaces.imageTooLarge)
    }
    e.target.value = ''
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError(t.spaces.errorNoName); return }

    setSaving(true)
    setError(null)

    try {
      if (mode === 'create') {
        const space = await createSpace(name.trim())
        // Update metadata (description, image) after creation
        if (description.trim() || image) {
          await updateSpace(space.id, {
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(image ? { image } : {}),
          })
        }
        navigate(`/spaces/${space.id}`, { replace: true })
      } else if (spaceId) {
        await updateSpace(spaceId, {
          name: name.trim(),
          description: description.trim(),
          image: image || '',
        })
        navigate(`/spaces/${spaceId}`, { replace: true })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t.spaces.errorCreationFailed)
      setSaving(false)
    }
  }

  if (loading) return <div className="text-muted-foreground">{t.common.loading}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate(mode === 'edit' ? `/spaces/${spaceId}` : '/spaces')}
          className="p-2 hover:bg-muted rounded-lg transition-colors"
          aria-label={t.aria.goBack}
        >
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-foreground">
          {mode === 'create' ? t.spaces.createTitle : t.spaces.editTitle}
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Avatar + Name — Signal-style horizontal layout */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="flex items-center gap-4">
            {/* Avatar area */}
            <label className="shrink-0 cursor-pointer group">
              {image ? (
                <div className="relative">
                  <img
                    src={image}
                    alt={name}
                    className="w-14 h-14 rounded-full object-cover ring-2 ring-border group-hover:ring-primary-400 transition-all"
                  />
                  <div className="absolute inset-0 rounded-full bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                    <ImagePlus size={16} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setImage(undefined) }}
                    className="absolute -top-1 -right-1 p-1 bg-destructive text-white rounded-full hover:bg-destructive/90 transition-colors"
                    aria-label={t.spaces.imageRemove}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ) : (
                <div className="w-14 h-14 rounded-full bg-primary-600/10 flex items-center justify-center group-hover:bg-primary-600/20 transition-colors ring-2 ring-transparent group-hover:ring-primary-400">
                  <ImagePlus size={20} className="text-primary-600/60 group-hover:text-primary-600 transition-colors" />
                </div>
              )}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
            </label>

            {/* Name input — borderless, just an underline */}
            <div className="flex-1 min-w-0">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t.spaces.namePlaceholder}
                className="w-full bg-transparent text-lg font-medium text-foreground placeholder-muted-foreground/40 border-b border-border focus:border-primary-500 focus:outline-none pb-1.5 transition-colors"
                autoFocus
              />
            </div>
          </div>
          {imageError && <p className="text-xs text-destructive mt-3 ml-[4.5rem]">{imageError}</p>}
        </div>

        {/* Description */}
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder={t.spaces.descriptionPlaceholder}
          rows={2}
          className="w-full px-4 py-3 bg-card border border-border rounded-2xl text-sm text-foreground placeholder-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />

        {error && <p className="text-sm text-destructive">{error}</p>}

        {mode === 'create' && (
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="w-full px-4 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
          >
            {saving ? t.common.loading : t.spaces.createButton}
          </button>
        )}
      </form>

      {/* Members + Invite + Leave (only in edit mode) */}
      {mode === 'edit' && space && (
        <>
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-foreground">
                {fmt(t.spaces.membersHeading, { count: String(space.members.length) })}
              </h2>
              {activeContacts.filter(c => !space.members.includes(c.did)).length > 0 && (
                <button
                  onClick={() => { setShowInviteDialog(true); setSelectedDids(new Set()); setError(null) }}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 rounded-lg transition-colors"
                >
                  <UserPlus size={14} />
                  {t.spaces.inviteButton}
                </button>
              )}
            </div>

            <div className="space-y-1.5">
              {space.members.map(memberDid => {
                const isSelf = memberDid === did
                const contact = activeContacts.find(c => c.did === memberDid)
                const memberName = isSelf ? (localIdentity?.profile?.name || t.identity.self) : (contact?.name || memberDid.slice(-12))
                const memberAvatar = isSelf ? localIdentity?.profile?.avatar : contact?.avatar
                const isCreator = memberDid === space.members[0]

                return (
                  <div key={memberDid} className="flex items-center justify-between bg-card border border-border rounded-xl px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={memberName} avatar={memberAvatar} size="xs" />
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-foreground">{memberName}</p>
                        {isCreator && <span className="text-[10px] text-primary-400 bg-primary-500/15 px-1.5 py-0.5 rounded">Admin</span>}
                        {isSelf && <span className="text-[10px] text-muted-foreground/70">{t.publicProfile.youSuffix}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Lock size={12} className="text-primary-500" />
                      {space.members[0] === did && memberDid !== did && (
                        <button
                          onClick={async () => {
                            try {
                              await removeMember(spaceId!, memberDid)
                              const s = await getSpace(spaceId!)
                              if (s) setSpace(s)
                            } catch (err) {
                              setError(err instanceof Error ? err.message : t.spaces.errorRemoveFailed)
                            }
                          }}
                          className="p-1.5 text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                          aria-label={t.aria.removeMember}
                        >
                          <UserMinus size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Leave Space */}
          <div className="pt-2 border-t border-border">
            {!showLeaveConfirm ? (
              <button
                onClick={() => setShowLeaveConfirm(true)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-destructive/70 hover:text-destructive hover:bg-destructive/10 rounded-xl transition-colors w-full"
              >
                <LogOut size={14} />
                {t.spaces.leaveButton}
              </button>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-foreground/80">{t.spaces.leaveConfirm}</p>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setLeaving(true)
                      try {
                        await leaveSpace(spaceId!)
                        navigate('/spaces')
                      } catch (err) {
                        setError(err instanceof Error ? err.message : t.spaces.leaveFailed)
                        setLeaving(false)
                        setShowLeaveConfirm(false)
                      }
                    }}
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
                  {activeContacts.filter(c => !space.members.includes(c.did)).length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">{t.spaces.noContactsToInvite}</p>
                  ) : (
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
                  )}
                </div>
                <div className="px-5 py-4 border-t border-border">
                  <button
                    onClick={async () => {
                      if (selectedDids.size === 0) return
                      setInviting(true)
                      for (const contactDid of selectedDids) {
                        try { await inviteMember(spaceId!, contactDid) } catch {}
                      }
                      const s = await getSpace(spaceId!)
                      if (s) setSpace(s)
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
        </>
      )}
    </div>
  )
}
