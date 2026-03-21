import { Link } from 'react-router-dom'
import { Users, UserPlus, Award, ArrowRight, WifiOff, CloudOff, Send, Lock } from 'lucide-react'
import { useContacts, useAttestations, useMessaging, useSyncStatus, useOutboxStatus, useLocalIdentity, useSpaces } from '../hooks'
import { useIdentity } from '../context'
import { useLanguage, plural } from '../i18n'

export function Home() {
  const { did } = useIdentity()
  const localIdentity = useLocalIdentity()
  const { activeContacts } = useContacts()
  const { myAttestations, receivedAttestations } = useAttestations()
  const { state: relayState, isConnected } = useMessaging()
  const { hasPendingSync, discoveryError } = useSyncStatus()
  const { pendingCount, hasPendingMessages } = useOutboxStatus()
  const { spaces } = useSpaces()

  const { t, fmt } = useLanguage()
  const displayName = localIdentity?.profile.name || (did ? `did:...${did.slice(-8)}` : '')

  const hasIssues = !isConnected || hasPendingSync || hasPendingMessages
  const sharedSpaces = spaces?.filter(s => s.type === 'shared') ?? []
  const previewSpaces = sharedSpaces.slice(0, 3)
  const hasMoreSpaces = sharedSpaces.length > 3

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{fmt(t.home.greeting, { name: displayName })}</h1>
        <p className="text-muted-foreground mt-1">{t.home.welcomeSubtitle}</p>
      </div>

      {/* Status */}
      {isConnected && (
        <span className="inline-flex items-center gap-1.5 text-sm text-success">
          <WifiOff size={14} className="hidden" />
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/></svg>
          {t.home.relayConnected}
        </span>
      )}
      {hasIssues && (
        <div className="flex flex-wrap gap-3 text-sm">
          {!isConnected && (
            <span className={`inline-flex items-center gap-1.5 ${
              relayState === 'connecting'
                ? 'text-amber-600'
                : 'text-muted-foreground'
            }`}>
              <WifiOff size={14} />
              {relayState === 'connecting' ? t.home.relayConnecting : t.home.relayOffline}
            </span>
          )}
          {hasPendingSync && (
            <span className="inline-flex items-center gap-1.5 text-amber-600">
              <CloudOff size={14} />
              {t.home.profileSyncPending}
              {discoveryError && (
                <span className="text-destructive">({discoveryError})</span>
              )}
            </span>
          )}
          {hasPendingMessages && (
            <span className="inline-flex items-center gap-1.5 text-amber-600">
              <Send size={14} />
              {fmt(plural(pendingCount, t.home.pendingMessagesOne, t.home.pendingMessagesMany), { count: pendingCount })}
            </span>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <Link to="/contacts" className="bg-card border border-border rounded-xl p-4 hover:border-primary-300 transition-colors text-center">
          <div className="w-10 h-10 bg-primary-600/15 rounded-lg flex items-center justify-center mx-auto mb-2">
            <Users className="w-5 h-5 text-primary-600" />
          </div>
          <div className="text-2xl font-bold text-foreground">{activeContacts.length}</div>
          <div className="text-xs text-muted-foreground">{t.home.contactsLabel}</div>
        </Link>
        <Link to="/attestations" className="bg-card border border-border rounded-xl p-4 hover:border-success/30 transition-colors text-center">
          <div className="w-10 h-10 bg-success/15 rounded-lg flex items-center justify-center mx-auto mb-2">
            <Award className="w-5 h-5 text-success" />
          </div>
          <div className="text-2xl font-bold text-foreground">{myAttestations.length}</div>
          <div className="text-xs text-muted-foreground">{t.home.createdLabel}</div>
        </Link>
        <Link to="/attestations" className="bg-card border border-border rounded-xl p-4 hover:border-accent-300 transition-colors text-center">
          <div className="w-10 h-10 bg-purple-600/15 rounded-lg flex items-center justify-center mx-auto mb-2">
            <Award className="w-5 h-5 text-purple-600" />
          </div>
          <div className="text-2xl font-bold text-foreground">{receivedAttestations.length}</div>
          <div className="text-xs text-muted-foreground">{t.home.receivedLabel}</div>
        </Link>
      </div>

      {/* Quick actions — verify + attestation */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t.home.quickActions}</h2>
        <Link
          to="/verify"
          className="flex items-center justify-between p-4 bg-card border border-border rounded-xl hover:border-primary-300 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary-600/15 rounded-lg flex items-center justify-center">
              <UserPlus className="w-5 h-5 text-primary-600" />
            </div>
            <div>
              <div className="font-medium text-foreground">{t.home.verifyContact}</div>
              <div className="text-sm text-muted-foreground">{t.home.verifyContactDesc}</div>
            </div>
          </div>
          <ArrowRight size={18} className="text-muted-foreground/70" />
        </Link>

        {activeContacts.length > 0 && (
          <Link
            to="/attestations/new"
            className="flex items-center justify-between p-4 bg-card border border-border rounded-xl hover:border-accent-300 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-accent-600/15 rounded-lg flex items-center justify-center">
                <Award className="w-5 h-5 text-accent-600" />
              </div>
              <div>
                <div className="font-medium text-foreground">{t.home.createAttestation}</div>
                <div className="text-sm text-muted-foreground">{t.home.createAttestationDesc}</div>
              </div>
            </div>
            <ArrowRight size={18} className="text-muted-foreground/70" />
          </Link>
        )}
      </div>

      {/* Spaces — max 3, compact */}
      {sharedSpaces.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-medium text-muted-foreground">{t.spaces.title}</h2>
            <Link to="/spaces/new" className="text-xs text-primary-600 hover:text-primary-700 transition-colors">
              + {t.spaces.createButton}
            </Link>
          </div>
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {previewSpaces.map(space => (
              <Link
                key={space.id}
                to={`/spaces/${space.id}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <Lock size={14} className="text-primary-500 flex-shrink-0" />
                  <span className="text-sm font-medium text-foreground truncate">{space.name || t.spaces.unnamed}</span>
                </div>
                <span className="text-xs text-muted-foreground/70 flex-shrink-0">
                  {space.members.length} {plural(space.members.length, t.common.personOne, t.common.personMany)}
                </span>
              </Link>
            ))}
          </div>
          {hasMoreSpaces && (
            <Link to="/spaces" className="block text-center text-xs text-muted-foreground hover:text-foreground mt-2 transition-colors">
              {t.spaces.title} ({sharedSpaces.length}) →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
