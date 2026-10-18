import { useI18n } from '../../i18n'

/** Crash and boot failure screen in the app language, without stack trace (architecture §6.2). */
export function ErrorScreen({ variant }: { variant: 'error' | 'not-ready' }) {
  const { t } = useI18n()
  const title = variant === 'error' ? t.app.errorTitle : t.app.notReadyTitle
  const body = variant === 'error' ? t.app.errorBody : t.app.notReadyBody
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[17px] font-semibold">{title}</div>
      <p className="m-0 max-w-[40ch] text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
