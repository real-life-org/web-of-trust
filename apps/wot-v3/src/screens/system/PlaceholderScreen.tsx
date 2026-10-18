import { useI18n } from '../../i18n'
import { CenteredNote, ListHeader } from '../../ui/components'

/** Tabs whose screens follow in later steps (groups, profile). */
export function PlaceholderScreen({ title }: { title: string }) {
  const { t } = useI18n()
  return (
    <>
      <ListHeader title={title} />
      <CenteredNote text={t.shell.comingNext} />
    </>
  )
}
