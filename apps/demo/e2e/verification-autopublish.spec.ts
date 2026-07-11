import { test, expect } from '@playwright/test'
import { createIdentity } from './helpers/identity'
import { createFreshContext, waitForRelayConnected, navigateTo } from './helpers/common'
import { performMutualVerification } from './helpers/verification'

/**
 * Regressionstest des Features (Teil A, Legacy-Parität): nach einer gegenseitigen
 * In-Person-Verifikation MUSS die Verifikation OHNE manuellen Consent-Toggle auf
 * dem Profilserver (/v) liegen. Beweis über die öffentliche Profilseite des Peers:
 * Bobs `/v` enthält Alices Verifikation → sein öffentliches Profil zeigt
 * "Verbunden mit 1 Person", ohne dass irgendjemand "Veröffentlichen" geklickt hat.
 *
 * Vor dem Auto-Publish landete jede eingehende Verifikation mit accepted:false und
 * wurde nie zu /v hochgeladen — die Verbunden-mit-Sektion wäre leer geblieben.
 */
test.describe('Verification auto-publish (Legacy-Parität)', () => {
  test('mutual verification appears on the peer public profile without a manual toggle', async ({ browser }) => {
    const { context: aliceCtx, page: alicePage } = await createFreshContext(browser)
    const { context: bobCtx, page: bobPage } = await createFreshContext(browser)

    try {
      await createIdentity(alicePage, { name: 'Alice', passphrase: 'alice123pw' })
      const { did: bobDid } = await createIdentity(bobPage, { name: 'Bob', passphrase: 'bob12345pw' })

      await waitForRelayConnected(alicePage)
      await waitForRelayConnected(bobPage)

      // Gegenseitige Verifikation — KEIN manueller Publish-Toggle danach.
      await performMutualVerification(alicePage, bobPage)

      // Debounced Auto-Upload (2s) + Profilserver-Sync abwarten.
      await bobPage.waitForTimeout(4_000)

      // Bobs öffentliches Profil: Alices Verifikation muss aus /v auftauchen.
      await navigateTo(alicePage, `/p/${bobDid}`)
      await expect(alicePage.getByText('Verbunden mit 1 Person')).toBeVisible({ timeout: 15_000 })
    } finally {
      await aliceCtx.close()
      await bobCtx.close()
    }
  })
})
