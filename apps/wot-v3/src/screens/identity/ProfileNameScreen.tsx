// The own name (Trust 6b, profile@1): one field, prefilled with the profile's name; saving draws the
// next profile revision, which the library delivers to every contact the profile class is on for,
// by default the trusted ones (2760, 6455). Others keep the name from the card they scanned. A page
// in the content column, "‹ Profile" on the desktop (handover desktop frames).
import { useState } from 'react'
import { usePort, useProfile } from '../../hooks'
import { useI18n } from '../../i18n'
import { Callout, Field, FlowPage, PrimaryAction } from '../../ui/components'

/** the library's bound on a profile name (lib PROFILE_LIMITS.name) */
export const NAME_MAX = 64

export function ProfileNameScreen({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const x = t.profileName
  const port = usePort()
  const profile = useProfile()
  const current = profile.status === 'ready' ? (profile.value.name ?? '') : ''
  const [value, setValue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const shown = value ?? current
  const name = shown.trim()
  const ready = name.length > 0 && name !== current.trim() && !busy
  const save = async () => {
    if (!ready) return
    setBusy(true)
    setFailed(false)
    try {
      const r = await port.trust.setProfile({ name }).done
      if (r.ok) onBack()
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <FlowPage title={x.title} onBack={onBack} footer={<PrimaryAction label={x.save} onClick={() => void save()} disabled={!ready} busy={busy} />}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label={x.label} hint={x.hint}>
          {(a) => (
            <input
              {...a}
              type="text"
              value={shown}
              autoComplete="name"
              autoFocus
              maxLength={NAME_MAX}
              onChange={(e) => setValue(e.target.value)}
              className="h-11 w-full rounded-lg border border-border bg-card px-4 text-[15px] outline-none focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring"
            />
          )}
        </Field>
        {failed ? (
          <Callout tone="danger" role="alert">
            {x.failed}
          </Callout>
        ) : null}
      </form>
    </FlowPage>
  )
}
