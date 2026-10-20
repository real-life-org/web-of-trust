// Encounter acts whose outcome was lost with the process (architecture §3.4, N3): never run on
// their own; the human confirms again (same card, same actId) or discards.
import { useInterruptedEncounters } from '../../hooks'
import { useI18n } from '../../i18n'
import { Button } from '../../ui/primitives'
import { Callout } from '../../ui/components'

export function InterruptedEncounters() {
  const { t, f } = useI18n()
  const i = t.intents
  const { items, confirm, discard } = useInterruptedEncounters()
  if (items.length === 0) return null
  return (
    <div className="flex flex-none flex-col gap-2">
      {items.map((it) => {
        const name = it.confirm?.preview.name ?? null
        return (
          <Callout key={it.actId} tone="warning" role="status">
            <div className="flex flex-col gap-2">
              <strong className="font-semibold">{name ? f(i.interruptedTitle, { name }) : i.interruptedTitleUnnamed}</strong>
              <span>{i.interruptedBody}</span>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void confirm(it.actId)}>
                  {i.confirm}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void discard(it.actId)}>
                  {i.discard}
                </Button>
              </div>
            </div>
          </Callout>
        )
      })}
    </div>
  )
}
