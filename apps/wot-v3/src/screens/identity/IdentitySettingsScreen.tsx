// Profile tab (canvas "Profil", rows as in Signal, Anton 29.10.): who you are at the top (avatar and
// name as your contacts see them), then the security rows (protection = password and biometrics, lock
// now) with the seed hint, then "Delete identity" in a card of its own, red; in a build with the
// interop probe, a developer row. Every row has its icon.
import { useIdentity, useInteropProbe, useNav, useProfile } from '../../hooks'
import { useI18n } from '../../i18n'
import { ActionList, KeyIcon, ListHeader, LockIcon, PencilIcon, PersonAvatar, ShieldIcon, TrashIcon } from '../../ui/components'

function SectionLabel({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} className="m-0 px-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
      {children}
    </h2>
  )
}

export function IdentitySettingsScreen({ onChangeProtection, onDelete, onLock }: { onChangeProtection: () => void; onDelete: () => void; onLock: () => void }) {
  const { t } = useI18n()
  const identity = useIdentity()
  const profile = useProfile()
  const mode = identity.status === 'unlocked' ? identity.protection : null
  const { probe } = useInteropProbe()
  const { send } = useNav()
  const me = profile.status === 'ready' ? profile.value : null
  const name = me?.name ?? t.contacts.unnamed
  return (
    <>
      <ListHeader title={t.nav.profile} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-6">
        {me ? (
          <section aria-labelledby="profile-me" className="flex flex-col gap-2">
            <h2 id="profile-me" className="sr-only">
              {t.profileTab.me}
            </h2>
            <div className="flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-4">
              <PersonAvatar name={name} image={me.image} size={56} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-lg font-semibold">{name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{me.anchorShort}</span>
              </div>
            </div>
            <ActionList rows={[{ icon: <PencilIcon />, label: t.profileTab.editName, onClick: () => send({ type: 'push', route: { kind: 'profile-name' } }) }]} />
          </section>
        ) : null}
        <section aria-labelledby="profile-security" className="flex flex-col gap-2">
          <SectionLabel id="profile-security">{t.profileTab.security}</SectionLabel>
          <ActionList
            rows={[
              ...(mode ? [{ icon: <ShieldIcon />, label: t.profileTab.protection, value: t.protection.mode[mode], onClick: onChangeProtection }] : []),
              { icon: <LockIcon />, label: t.profileTab.lock, onClick: onLock },
            ]}
          />
          <p className="m-0 px-1 text-[13px] text-pretty text-muted-foreground">{t.profileTab.seedHint}</p>
        </section>
        <section aria-labelledby="profile-identity" className="flex flex-col gap-2">
          <SectionLabel id="profile-identity">{t.profileTab.identity}</SectionLabel>
          <ActionList rows={[{ icon: <TrashIcon />, label: t.profileTab.delete, tone: 'destructive', onClick: onDelete }]} />
        </section>
        {probe ? (
          <section aria-labelledby="profile-developer" className="flex flex-col gap-2">
            <SectionLabel id="profile-developer">{t.profileTab.developer}</SectionLabel>
            <ActionList rows={[{ icon: <KeyIcon />, label: t.profileTab.interop, onClick: () => send({ type: 'push', route: { kind: 'interop' } }) }]} />
          </section>
        ) : null}
      </div>
    </>
  )
}
