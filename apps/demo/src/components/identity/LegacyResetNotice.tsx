import { useIdentity } from '../../context/IdentityContext'
import { useLanguage } from '../../i18n'

/**
 * One-time notice shown when a legacy (pre-current-schema) local dataset was
 * wiped on startup by the storage-schema gate. Informs the user about the
 * identity break before they create a new identity.
 */
export function LegacyResetNotice() {
  const { storageWasReset, dismissStorageResetNotice } = useIdentity()
  const { t } = useLanguage()

  if (!storageWasReset) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legacy-reset-title"
    >
      <div className="max-w-md w-full bg-card rounded-2xl shadow-xl border border-border p-6 space-y-4">
        <h2 id="legacy-reset-title" className="text-xl font-bold text-foreground">
          {t.legacyReset.title}
        </h2>
        <p className="text-muted-foreground">{t.legacyReset.body}</p>
        <button
          onClick={dismissStorageResetNotice}
          className="w-full py-3 bg-primary-600 text-white font-medium rounded-lg hover:bg-primary-700 transition-colors"
        >
          {t.legacyReset.dismiss}
        </button>
      </div>
    </div>
  )
}
