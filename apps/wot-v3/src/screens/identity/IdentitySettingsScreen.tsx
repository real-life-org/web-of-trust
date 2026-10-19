// Profile tab, identity part (design: profile section "Sicherheit"): protection mode with "Change",
// lock now, the seed hint, and "Delete identity". The rest of the profile tab follows with its screens.
import { useIdentity } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/primitives'
import { ListHeader, LockIcon, ShieldIcon, TrashIcon } from '../../ui/components'

function SectionLabel({ children }: { children: string }) {
  return <h2 className="m-0 px-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{children}</h2>
}

export function IdentitySettingsScreen({ onChangeProtection, onDelete, onLock }: { onChangeProtection: () => void; onDelete: () => void; onLock: () => void }) {
  const { t } = useI18n()
  const identity = useIdentity()
  const mode = identity.status === 'unlocked' ? identity.protection : null
  return (
    <>
      <ListHeader title={t.nav.profile} />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-4 pb-6">
        <section className="flex flex-col gap-2">
          <SectionLabel>{t.profileTab.security}</SectionLabel>
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-8 flex-none items-center justify-center rounded-full bg-muted text-muted-foreground">
                <ShieldIcon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{t.profileTab.protection}</span>
                <span className="text-xs text-muted-foreground">{mode ? t.protection.mode[mode] : ''}</span>
              </span>
              <Button variant="outline" size="sm" onClick={onChangeProtection} disabled={mode === null}>
                {t.profileTab.change}
              </Button>
            </div>
            <div className="flex items-center gap-3 px-4 py-3">
              <span className="flex size-8 flex-none items-center justify-center rounded-full bg-muted text-muted-foreground">
                <LockIcon className="size-4" />
              </span>
              <span className="flex-1 text-[13px] text-pretty text-muted-foreground">{t.profileTab.seedHint}</span>
            </div>
          </div>
          <Button variant="outline" className="h-11 w-full" onClick={onLock}>
            <LockIcon />
            {t.profileTab.lock}
          </Button>
        </section>
        <section className="flex flex-col gap-2">
          <SectionLabel>{t.profileTab.identity}</SectionLabel>
          <Button variant="outline" className="h-11 w-full border-[color-mix(in_oklab,var(--destructive)_40%,var(--border))] text-destructive hover:bg-[color-mix(in_oklab,var(--destructive)_8%,transparent)] hover:text-destructive" onClick={onDelete}>
            <TrashIcon />
            {t.profileTab.delete}
          </Button>
        </section>
      </div>
    </>
  )
}
