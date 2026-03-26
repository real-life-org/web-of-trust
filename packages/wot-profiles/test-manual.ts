/**
 * Manueller Test: wot-profiles Service
 *
 * Voraussetzung: Service läuft auf Port 8788
 *   pnpm --filter wot-profiles dev
 *
 * Ausführen:
 *   npx tsx packages/wot-profiles/test-manual.ts
 */
import { WotIdentity, ProfileService } from '@web.of.trust/core'

const BASE_URL = 'http://localhost:8788'

async function main() {
  console.log('=== wot-profiles Manual Test ===\n')

  // 1. Identity erstellen
  const identity = new WotIdentity()
  await identity.create('test-manual-passphrase', false)
  const did = identity.getDid()
  console.log('✓ Identity erstellt')
  console.log(`  DID: ${did}\n`)

  // 2. Profil signieren
  const profile = {
    did,
    name: 'Anton Test',
    bio: 'Manueller Test des Profile Service',
    updatedAt: new Date().toISOString(),
  }
  const jws = await ProfileService.signProfile(profile, identity)
  console.log('✓ Profil signiert (JWS)')
  console.log(`  JWS: ${jws.substring(0, 60)}...\n`)

  // 3. GET vor PUT — sollte 404 sein
  const res404 = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`)
  console.log(`✓ GET vor PUT: ${res404.status} (erwartet: 404)`)
  console.log(`  ${res404.status === 404 ? 'OK' : 'FEHLER!'}\n`)

  // 4. PUT — Profil hochladen
  const resPut = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
    method: 'PUT',
    body: jws,
  })
  const putBody = await resPut.text()
  console.log(`✓ PUT Profil: ${resPut.status} (erwartet: 200)`)
  console.log(`  ${resPut.status === 200 ? 'OK' : 'FEHLER!'} — ${putBody}\n`)

  // 5. GET — Profil abrufen
  const resGet = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`)
  const getBody = await resGet.text()
  console.log(`✓ GET Profil: ${resGet.status} (erwartet: 200)`)
  console.log(`  Content-Type: ${resGet.headers.get('content-type')}`)
  console.log(`  JWS match: ${getBody === jws ? 'OK' : 'FEHLER!'}\n`)

  // 6. Profil verifizieren (Client-seitig)
  const verified = await ProfileService.verifyProfile(getBody)
  console.log(`✓ Profil verifiziert: ${verified.valid ? 'OK' : 'FEHLER!'}`)
  if (verified.profile) {
    console.log(`  Name: ${verified.profile.name}`)
    console.log(`  Bio: ${verified.profile.bio}`)
    console.log(`  DID: ${verified.profile.did}`)
  }

  // 7. Tampered JWS — sollte 400 sein
  const tamperedJws = jws.slice(0, -5) + 'XXXXX'
  const resTampered = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
    method: 'PUT',
    body: tamperedJws,
  })
  console.log(`\n✓ PUT tampered JWS: ${resTampered.status} (erwartet: 400)`)
  console.log(`  ${resTampered.status === 400 ? 'OK' : 'FEHLER!'}\n`)

  // 8. DID mismatch — sollte 403 sein
  const fakeDid = 'did:key:zFAKE123456789'
  const resMismatch = await fetch(`${BASE_URL}/p/${encodeURIComponent(fakeDid)}`, {
    method: 'PUT',
    body: jws,
  })
  console.log(`✓ PUT DID mismatch: ${resMismatch.status} (erwartet: 403)`)
  console.log(`  ${resMismatch.status === 403 ? 'OK' : 'FEHLER!'}\n`)

  // 9. CORS Header prüfen
  const corsRes = await fetch(`${BASE_URL}/p/${encodeURIComponent(did)}`, {
    method: 'OPTIONS',
  })
  const corsOrigin = corsRes.headers.get('access-control-allow-origin')
  console.log(`✓ CORS: Access-Control-Allow-Origin = ${corsOrigin}`)
  console.log(`  ${corsOrigin === '*' ? 'OK' : 'FEHLER!'}\n`)

  // Cleanup
  try { await identity.deleteStoredIdentity() } catch {}

  console.log('=== Alle manuellen Tests abgeschlossen ===')
}

main().catch(console.error)
