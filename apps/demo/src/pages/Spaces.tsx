import { useMemo } from 'react'
import { Link, Routes, Route } from 'react-router-dom'
import { Plus, Lock, Users } from 'lucide-react'
import { useSpaces } from '../hooks'
import { useIdentity } from '../context'
import { useLanguage } from '../i18n'
import { Avatar } from '../components/shared'
import { SpaceForm } from '../components/spaces/SpaceForm'
import { SpaceDetail } from './SpaceDetail'

function SpacesIndex() {
  const { t } = useLanguage()
  const { spaces, loading } = useSpaces()
  const { did } = useIdentity()
  const mySpaces = useMemo(() => did ? spaces.filter(s => s.members.includes(did)) : [], [spaces, did])

  if (loading) {
    return <div className="text-muted-foreground">{t.common.loading}</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t.spaces.title}</h1>
        <Link
          to="/spaces/new"
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus size={16} />
          {t.spaces.createButton}
        </Link>
      </div>

      {mySpaces.length === 0 ? (
        <div className="text-center py-12 space-y-3">
          <Users className="w-12 h-12 text-muted-foreground/50 mx-auto" />
          <h3 className="text-lg font-semibold text-foreground/80">{t.spaces.emptyTitle}</h3>
          <p className="text-muted-foreground">{t.spaces.emptyDescription}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {mySpaces.map(space => (
            <Link
              key={space.id}
              to={`/spaces/${space.id}`}
              className="flex items-center gap-3 bg-card rounded-xl border border-border p-3 hover:border-primary-300 transition-colors"
            >
              <Avatar name={space.name || t.spaces.unnamed} avatar={space.image} size="md" />
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground truncate">{space.name || t.spaces.unnamed}</h3>
                {space.description && (
                  <p className="text-xs text-muted-foreground/70 truncate">{space.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  {space.members.length} {space.members.length === 1 ? t.common.personOne : t.common.personMany}
                </p>
              </div>
              <Lock size={14} className="text-primary-600 shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

export function Spaces() {
  return (
    <Routes>
      <Route index element={<SpacesIndex />} />
      <Route path="new" element={<SpaceForm mode="create" />} />
      <Route path=":spaceId" element={<SpaceDetail />} />
      <Route path=":spaceId/edit" element={<SpaceForm mode="edit" />} />
    </Routes>
  )
}
