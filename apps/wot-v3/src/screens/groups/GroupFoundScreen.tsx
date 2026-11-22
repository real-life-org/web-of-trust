// Found a group: its name, nothing else. The founder is its first member; everyone else comes in by
// an invitation. A page in the content column.
import { useState } from 'react'
import type { GroupId } from '../../port'
import { usePort } from '../../hooks'
import { useI18n } from '../../i18n'
import { Callout, Field, FlowPage, PrimaryAction } from '../../ui/components'

/** the app's bound on a group's name, the same as a person's */
export const GROUP_NAME_MAX = 64

export function GroupFoundScreen({ onBack, onFounded }: { onBack: () => void; onFounded: (id: GroupId) => void }) {
  const { t } = useI18n()
  const x = t.groups
  const port = usePort()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const name = value.trim()
  const ready = name.length > 0 && !busy
  const save = async () => {
    if (!ready) return
    setBusy(true)
    setFailed(false)
    try {
      const r = await port.trust.foundGroup({ name }).done
      if (r.ok) onFounded(r.value.groupId)
      else setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <FlowPage title={x.found} onBack={onBack} footer={<PrimaryAction label={x.foundConfirm} onClick={() => void save()} disabled={!ready} busy={busy} />}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field label={x.nameLabel} hint={x.nameHint}>
          {(a) => (
            <input
              {...a}
              type="text"
              value={value}
              autoComplete="off"
              autoFocus
              maxLength={GROUP_NAME_MAX}
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
