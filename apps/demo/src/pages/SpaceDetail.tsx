import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, UserPlus, UserMinus, Lock, ShieldCheck } from 'lucide-react'
import { useSpaces, useContacts } from '../hooks'
import { useIdentity } from '../context'
import { useLanguage } from '../i18n'
import type { SpaceInfo } from '@real-life/wot-core'

export function SpaceDetail() {
  const { spaceId } = useParams<{ spaceId: string }>()
  const { t, fmt } = useLanguage()
  const navigate = useNavigate()
  const { getSpace, inviteMember, removeMember } = useSpaces()
  const { activeContacts } = useContacts()
  const { did } = useIdentity()
  const [space, setSpace] = useState<SpaceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [showInvite, setShowInvite] = useState(false)
  const [inviting, setInviting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!spaceId) return
    getSpace(spaceId).then(s => { setSpace(s); setLoading(false) })
  }, [spaceId, getSpace])

  const refreshSpace = async () => {
    if (!spaceId) return
    const s = await getSpace(spaceId)
    setSpace(s)
  }

  if (loading) return <div className="text-slate-500">{t.common.loading}</div>
  if (!space) return <div className="text-slate-500">{t.spaces.notFound}</div>

  const isCreator = space.members[0] === did
  const invitableContacts = activeContacts.filter(c => !space.members.includes(c.did))

  const handleInvite = async (contactDid: string) => {
    setInviting(true)
    setError(null)
    try {
      await inviteMember(space.id, contactDid)
      await refreshSpace()
      setShowInvite(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t.spaces.errorInviteFailed)
    }
    setInviting(false)
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

  const getMemberName = (memberDid: string) => {
    if (memberDid === did) return t.identity.self
    const contact = activeContacts.find(c => c.did === memberDid)
    return contact?.name || memberDid.slice(-12)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/spaces')} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
          <ArrowLeft size={20} />
        </button>
        <h1 className="text-2xl font-bold text-slate-900">{space.name || t.spaces.unnamed}</h1>
      </div>

      <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl">
        <ShieldCheck size={18} className="text-emerald-600" />
        <span className="text-sm text-emerald-800">{t.spaces.encryptedBadge}</span>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-slate-900">
            {fmt(t.spaces.membersHeading, { count: String(space.members.length) })}
          </h2>
          {isCreator && invitableContacts.length > 0 && (
            <button
              onClick={() => setShowInvite(!showInvite)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
            >
              <UserPlus size={16} />
              {t.spaces.inviteButton}
            </button>
          )}
        </div>

        {showInvite && (
          <div className="mb-4 border border-slate-200 rounded-xl overflow-hidden">
            {invitableContacts.map(contact => (
              <button
                key={contact.did}
                onClick={() => handleInvite(contact.did)}
                disabled={inviting}
                className="w-full px-4 py-3 text-left hover:bg-slate-50 border-b last:border-b-0 border-slate-100 disabled:opacity-50 transition-colors"
              >
                <span className="font-medium">{contact.name || contact.did.slice(-12)}</span>
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-sm text-red-600 mb-3">{error}</p>}

        <div className="space-y-2">
          {space.members.map(memberDid => (
            <div key={memberDid} className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div>
                <p className="font-medium text-slate-900">{getMemberName(memberDid)}</p>
                <p className="text-xs text-slate-400 font-mono truncate max-w-[200px]">{memberDid}</p>
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
          ))}
        </div>
      </div>

      <div className="text-xs text-slate-400 space-y-1">
        <p>{t.spaces.createdAt}: {new Date(space.createdAt).toLocaleDateString()}</p>
        <p>ID: {space.id.slice(0, 8)}...</p>
      </div>
    </div>
  )
}
