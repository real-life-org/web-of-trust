import { useI18n } from '../../i18n'

/** Crash and boot failure screen in the app language, without stack trace (architecture §6.2). */
export function ErrorScreen() {
  const { t } = useI18n()
  const title = t.app.errorTitle
  const body = t.app.errorBody
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[17px] font-semibold">{title}</div>
      <p className="m-0 max-w-[40ch] text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
