// The trust of the contact detail (Trust §2a; handover desktop frames PR 3, Anton 30.10.): two lines,
// what the contact disclosed to you and what you disclosed, the one switch (the anchor mapping class,
// 2770; a question before each change, TrustSheet), and under "Set individually" the switches of the
// five classes (2780, 2810), each a direct act. Nothing on the wire says "trust": a class on sends
// that class's artifact, off sends nothing.
import { useState, type ReactNode, type RefObject } from 'react'
import type { ClassState, ContactDetail, TrustClass } from '../../port'
import { useTrust } from '../../hooks'
import { useI18n } from '../../i18n'
import { Switch } from '../../ui/primitives'
import { ArrowDownIcon, ArrowUpIcon, ChevronRightIcon, DetailLine } from '../../ui/components'
import { TrustSheet } from './TrustSheet'

/** the classes in the order of the list: the anchor first (the trust itself), then what follows it */
const TRUST_CLASSES: readonly TrustClass[] = ['anchorMapping', 'profile', 'star', 'groupStar', 'sealedGroupStar']

export function TrustSection({ contact: c, name, fallbackFocus }: { contact: ContactDetail; name: string; fallbackFocus: RefObject<HTMLElement | null> }) {
  const { t, f } = useI18n()
  const d = t.contactDetail
  const tr = c.trust
  const act = useTrust(c.id)
  const [sheet, setSheet] = useState<'on' | 'off' | null>(null)
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<TrustClass | null>(null)
  const toggle = async (cls: TrustClass, on: boolean) => {
    setFailed(null)
    const r = await act.setClass(cls, on ? 'on' : 'off')
    if (!r.ok) setFailed(cls)
  }
  const card = (dir: 'in' | 'out', children: ReactNode) => (
    <div className="flex gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
      <span className="mt-0.5 flex-none text-muted-foreground [&_svg]:size-[18px] [&_svg]:stroke-[1.75]">{dir === 'in' ? <ArrowDownIcon /> : <ArrowUpIcon />}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">{children}</div>
    </div>
  )
  return (
    <section className="flex flex-none flex-col gap-2">
      <h2 className="m-0 px-1 text-[11px] font-semibold tracking-[.08em] text-muted-foreground uppercase">{d.trust}</h2>
      {/* received: the contact's statement, derived from the verified anchor you hold; the arrow is the direction */}
      {card('in', <DetailLine main={f(tr.received ? d['trust.received'] : d['trust.notReceived'], { name })} sub={f(tr.received ? d['trust.receivedSub'] : d['trust.notReceivedSub'], { name })} />)}
      {/* given: the switch in the main line, the classes set individually below (canvas variant D) */}
      {card(
        'out',
        <>
          <div className="flex items-start justify-between gap-3">
            <p className="m-0 text-sm text-pretty">
              <span id={`${c.id}-trust-switch`}>{f(tr.given ? d['trust.given'] : d['trust.notGiven'], { name })}</span>
            </p>
            <Switch
              aria-labelledby={`${c.id}-trust-switch`}
              checked={tr.given}
              disabled={!(tr.given ? c.actions.withdrawTrust.ok : c.actions.giveTrust.ok)}
              onCheckedChange={(on) => setSheet(on ? 'on' : 'off')}
              className="-mt-px"
            />
          </div>
          <p className="m-0 text-xs text-pretty text-muted-foreground">
            {f(tr.given ? d['trust.givenSub'] : d['trust.notGivenSub'], { name })}
            {tr.pending ? ` · ${d.pending}` : ''}
          </p>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={`${c.id}-classes`}
            onClick={() => setOpen((v) => !v)}
            className="hit-target relative -mx-1 flex min-h-9 items-center gap-1 self-start rounded-md px-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            {d.classesToggle}
            <ChevronRightIcon className={open ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'} />
          </button>
          {open ? (
            <ul id={`${c.id}-classes`} aria-label={d.classesToggle} className="m-0 flex list-none flex-col divide-y divide-border border-t border-border">
              {TRUST_CLASSES.map((cls) => {
                const cs: ClassState = c.classes[cls]
                const label = d.classes[cls]
                return (
                  <li key={cls} className="flex min-h-12 items-center justify-between gap-3 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span id={`${c.id}-class-${cls}`} className={cls === 'anchorMapping' ? 'text-sm font-semibold' : 'text-sm font-medium'}>
                        {label.name}
                      </span>
                      <span className="text-xs text-pretty text-muted-foreground">
                        {f(label.body, { name })}
                        {cs.setting === 'default' ? ` · ${d.classDefault}` : ''}
                      </span>
                      {failed === cls ? (
                        <span role="alert" className="text-xs text-destructive-strong">
                          {t.trustSheet.failed}
                        </span>
                      ) : null}
                    </span>
                    <Switch aria-labelledby={`${c.id}-class-${cls}`} checked={cs.on} disabled={c.blocked || act.busy} onCheckedChange={(on) => void toggle(cls, on)} />
                  </li>
                )
              })}
            </ul>
          ) : null}
        </>,
      )}
      {sheet ? <TrustSheet contactId={c.id} name={name} mode={sheet} open onClose={() => setSheet(null)} fallbackFocus={fallbackFocus} /> : null}
    </section>
  )
}
