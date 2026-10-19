// Identity states without a flow (architecture §2.3 IdentityState): booting, storage blocked
// (legacy storage-guard.ts, b987fb84), crypto missing, other writer, restore switching.
import { useI18n } from '../../i18n'
import { AlertIcon, FlowPage, Hero, LockIcon, PrimaryAction, Working } from '../../ui/components'

type IdentityStatus = 'booting' | 'storage-blocked' | 'crypto-unavailable' | 'other-writer' | 'restore-switch'

export function IdentityStatusScreen({ status, onRetry }: { status: IdentityStatus; onRetry?: () => void }) {
  const { t } = useI18n()
  const reload = onRetry ? <PrimaryAction label={t.identitySystem.reload} onClick={onRetry} /> : undefined
  switch (status) {
    case 'booting':
      return (
        <FlowPage title={t.app.name}>
          <Working label={t.identitySystem.booting} />
        </FlowPage>
      )
    case 'restore-switch':
      return (
        <FlowPage title={t.app.name}>
          <Working label={t.identitySystem.restoreSwitch} />
        </FlowPage>
      )
    case 'storage-blocked':
      return (
        <FlowPage title={t.app.name} footer={reload}>
          <div role="alert" className="flex flex-1 flex-col justify-center">
            <Hero icon={<AlertIcon />} tone="warning" title={t.identitySystem.storageBlockedTitle} body={t.identitySystem.storageBlockedBody} />
          </div>
        </FlowPage>
      )
    case 'crypto-unavailable':
      return (
        <FlowPage title={t.app.name}>
          <div role="alert" className="flex flex-1 flex-col justify-center">
            <Hero icon={<AlertIcon />} tone="warning" title={t.identitySystem.cryptoTitle} body={t.identitySystem.cryptoBody} />
          </div>
        </FlowPage>
      )
    case 'other-writer':
      return (
        <FlowPage title={t.app.name} footer={onRetry ? <PrimaryAction label={t.common.retry} onClick={onRetry} /> : undefined}>
          <div className="flex flex-1 flex-col justify-center">
            <Hero icon={<LockIcon />} tone="muted" title={t.identitySystem.otherWriterTitle} body={t.identitySystem.otherWriterBody} />
          </div>
        </FlowPage>
      )
  }
}
