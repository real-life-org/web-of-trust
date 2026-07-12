import { useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import { ContactList } from '../components'
import { Network } from './Network'
import { useLanguage } from '../i18n'

type ContactsTab = 'list' | 'graph'

export function Contacts() {
  const { t } = useLanguage()
  const [tab, setTab] = useState<ContactsTab>('list')

  const tabs: { id: ContactsTab; label: string }[] = [
    { id: 'list', label: t.contacts.tabList },
    { id: 'graph', label: t.contacts.tabGraph },
  ]

  // Pfeiltasten wechseln zwischen den Segmenten (WAI-ARIA Tabs-Pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const idx = tabs.findIndex(x => x.id === tab)
    const nextIdx = e.key === 'ArrowRight'
      ? (idx + 1) % tabs.length
      : (idx - 1 + tabs.length) % tabs.length
    setTab(tabs[nextIdx].id)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{t.contacts.title}</h1>
        <Link
          to="/verify"
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          <UserPlus size={16} />
          {t.contacts.verifyButton}
        </Link>
      </div>

      {/* Segmented Control „Liste | Graph" — ruhig, Signal-artig (apps/demo/CLAUDE.md) */}
      <div
        role="tablist"
        aria-label={t.contacts.title}
        onKeyDown={onKeyDown}
        className="flex gap-1 p-1 rounded-lg bg-muted"
      >
        {tabs.map(x => {
          const active = x.id === tab
          return (
            <button
              key={x.id}
              role="tab"
              id={`contacts-tab-${x.id}`}
              type="button"
              aria-selected={active}
              aria-controls={`contacts-panel-${x.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(x.id)}
              className={`flex-1 px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
                active
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {x.label}
            </button>
          )
        })}
      </div>

      {tab === 'list' && (
        <div
          role="tabpanel"
          id="contacts-panel-list"
          aria-labelledby="contacts-tab-list"
        >
          <ContactList />
        </div>
      )}

      {/* Graph nur mounten, solange der Tab aktiv ist → useGraphLivePolling
          stoppt beim Wechsel zur Liste (kein Timer-Leak, Codex #6). */}
      {tab === 'graph' && (
        <div
          role="tabpanel"
          id="contacts-panel-graph"
          aria-labelledby="contacts-tab-graph"
          className="h-[60vh] min-h-[360px]"
        >
          <Network embedded />
        </div>
      )}
    </div>
  )
}
