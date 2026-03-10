import { useState } from 'react'
import { Link, Routes, Route, useNavigate } from 'react-router-dom'
import { Plus, Lock, Users } from 'lucide-react'
import { useSpaces } from '../hooks'
import { useLanguage } from '../i18n'
import { SpaceDetail } from './SpaceDetail'

function SpacesIndex() {
  const { t } = useLanguage()
  const { spaces, loading } = useSpaces()

  if (loading) {
    return <div className="text-slate-500">{t.common.loading}</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">{t.spaces.title}</h1>
        <Link
          to="/spaces/new"
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus size={16} />
          {t.spaces.createButton}
        </Link>
      </div>

      {spaces.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <Users className="w-12 h-12 text-slate-300 mx-auto" />
          <h3 className="text-lg font-semibold text-slate-700">{t.spaces.emptyTitle}</h3>
          <p className="text-slate-500">{t.spaces.emptyDescription}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {spaces.map(space => (
            <Link
              key={space.id}
              to={`/spaces/${space.id}`}
              className="block bg-white rounded-xl border border-slate-200 p-4 hover:border-primary-300 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">{space.name || t.spaces.unnamed}</h3>
                  <p className="text-sm text-slate-500">
                    {space.members.length} {space.members.length === 1 ? t.common.personOne : t.common.personMany}
                  </p>
                </div>
                <Lock size={16} className="text-emerald-600" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function CreateSpace() {
  const { t } = useLanguage()
  const { createSpace } = useSpaces()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError(t.spaces.errorNoName); return }
    setCreating(true)
    try {
      const space = await createSpace(name.trim())
      navigate(`/spaces/${space.id}`)
    } catch (err) {
      console.error('Space creation failed:', err)
      setError(t.spaces.errorCreationFailed)
      setCreating(false)
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-slate-900">{t.spaces.createTitle}</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">
            {t.spaces.nameLabel}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.spaces.namePlaceholder}
            className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            autoFocus
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={creating}
          className="w-full px-4 py-3 bg-primary-600 text-white font-medium rounded-xl hover:bg-primary-700 transition-colors disabled:opacity-50"
        >
          {creating ? t.spaces.creating : t.spaces.createButton}
        </button>
      </form>
    </div>
  )
}

export function Spaces() {
  return (
    <Routes>
      <Route index element={<SpacesIndex />} />
      <Route path="new" element={<CreateSpace />} />
      <Route path=":spaceId" element={<SpaceDetail />} />
    </Routes>
  )
}
