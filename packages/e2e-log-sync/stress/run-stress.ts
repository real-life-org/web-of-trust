/**
 * Festival-Scale-Stress — standalone runner (tsx, long-running, CI-excluded).
 *
 * Drives ~festival scale (users / dual-device / spaces) through warm-up, write bursts,
 * an offline catch-up storm, one member-removal-triggered rotation per space, and
 * inbox-retention pressure — then AUDITS zero-loss at the wire (logical writeIds, not
 * relay seqs) + zero-error, and writes a machine-readable report.
 *
 * Run:  pnpm --filter @web_of_trust/e2e-log-sync stress
 * Env:  see stress/README.md (USERS, SPACES, SEED, STRESS_RELAY_PORT, REMOTE_RELAY_URL…).
 *
 * Hard gates: process-survived, zero-loss (writeId completeness), zero UNEXPECTED errors,
 * removed-member-reads-nothing, remaining-members-write-after-rotation. Latencies +
 * convergence times are BASELINE (reported, not gated).
 */
import 'fake-indexeddb/auto'
import { loadConfig, makeRng, rngInt } from './config'
import { assertNotProdRelay } from './prod-guard'
import { spawnRelay, type RelayProcess } from './relay-process'
import { auditSpace, type SpaceKeyAccess, type SpaceAuditResult } from './audit'
import { writeReport, percentiles, type StressReport, type ResourceSnapshot } from './report'
import {
  makeIdentity,
  startRemoteRelay,
  httpBaseFromWsUrl,
  waitFor,
  wait,
  type StartedRelay,
} from '../tests/harness'
import { makeYjsClient, type YjsClient } from '../tests/yjs-client'

interface StressDoc {
  items: Record<string, { title: string }>
  _stressWrites: Record<string, { authorDevice: string; sentAt: number }>
}

interface Device {
  deviceId: string
  client: YjsClient
  userIndex: number
  /** second device of a dual-device user (shares key/metadata; loads spaces via requestSync). */
  isSecond: boolean
  /** rebuildable identity/store refs so an "offline" device can cold-reconnect. */
  makeReconnect: () => Promise<YjsClient>
  offline: boolean
  /**
   * Error frames from PRIOR client instances of this device (folded in before each reconnect),
   * so the zero-error tally survives an offline reconnect that swaps `client` for a fresh probe.
   * The live tally is `errorFramesAccum` + `client.probe.errorFramesByCode`.
   */
  errorFramesAccum: Record<string, number>
}

interface SpacePlan {
  spaceId: string
  creatorUserIndex: number
  /** user indices that are members (incl. creator). */
  memberUserIndices: number[]
  /** the user removed during rotation (undefined until phase 5). */
  removedUserIndex?: number
}

const CONVERGE_BUDGET_MS = 60_000
const LATENCY_SAMPLE_CAP = 200
const SATURATION_LAG_MS = 250

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[stress ${new Date().toISOString()}] ${msg}`)
}

async function fetchResources(relayUrl: string): Promise<ResourceSnapshot | null> {
  try {
    const res = await fetch(`${httpBaseFromWsUrl(relayUrl)}/dashboard/data`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return null
    const j = (await res.json()) as {
      memoryMB?: number
      connectionCount?: number
      logStats?: { totalLogBytes?: number; docCount?: number }
    }
    return {
      memoryMB: j.memoryMB ?? 0,
      totalLogBytes: j.logStats?.totalLogBytes ?? 0,
      docCount: j.logStats?.docCount ?? 0,
      connectionCount: j.connectionCount ?? 0,
    }
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const cfg = loadConfig(process.env, new Date())
  const notes: string[] = []

  // ── PROD-GUARD (hard, before anything connects/spawns) ───────────────────────
  assertNotProdRelay(cfg.relayUrl)
  if (cfg.mode === 'S' && !cfg.allowDestructiveRemote) {
    throw new Error(
      'Mode S (remote staging) is DESTRUCTIVE (rotations). Set REMOTE_ALLOW_DESTRUCTIVE=1 and coordinate with Anton ' +
        '(shared staging relay; Spur-B dry-runs run there).',
    )
  }
  if (cfg.mode === 'S') notes.push('Mode S against shared staging — reduced scale; coordinate before running.')

  log(`mode=${cfg.mode} relay=${cfg.relayUrl} users=${cfg.users} spaces=${cfg.spaces} seed=${cfg.seed}`)

  // ── client-saturation detector (event-loop lag) ──────────────────────────────
  let maxLagMs = 0
  let lagLast = Date.now()
  const lagTimer = setInterval(() => {
    const now = Date.now()
    const lag = now - lagLast - 50
    if (lag > maxLagMs) maxLagMs = lag
    lagLast = now
  }, 50)
  lagTimer.unref()

  // relayProc is declared here (not in the try) so the catch-path teardown can always kill it.
  let relayProc: RelayProcess | null = null
  const rng = makeRng(cfg.seed)
  const devices: Device[] = []
  const spaces: SpacePlan[] = []
  const reconnects = { count: 0 }

  const gates = {
    processSurvived: false,
    zeroLoss: false,
    zeroUnexpectedErrors: false,
    removedMemberReadsNothing: false,
    remainingMembersWriteAfterRotation: false,
    passed: false,
  }
  let audit: SpaceAuditResult[] = []
  const latencySamples: number[] = []
  const convergence = { devicesChecked: 0, devicesConverged: 0, timeToConvergeMs: null as number | null }
  let catchUpConvergeMs: number | null = null

  try {
    // ── relay: Mode L spawns a subprocess; Mode S observes staging (inside the try so a
    // spawn/startup failure routes through the structured teardown + exit(2), not an unhandled
    // rejection) ─────────────────────────────────────────────────────────────────
    if (cfg.mode === 'L') {
      log('spawning relay subprocess…')
      relayProc = await spawnRelay({ port: cfg.port, dbPath: cfg.dbPath, artifactsDir: cfg.artifactsDir })
      log(`relay ready at ${relayProc.url}`)
    }
    const relay: StartedRelay = startRemoteRelay(cfg.relayUrl)
    const resourcesStart = await fetchResources(cfg.relayUrl)

    // ── PHASE 1: setup ─────────────────────────────────────────────────────────
    log('phase 1: identities + clients (staggered connect)…')
    const users: { identity: Awaited<ReturnType<typeof makeIdentity>>; primaryDevice: Device }[] = []
    for (let u = 0; u < cfg.users; u++) {
      const identity = await makeIdentity()
      const isDual = u < cfg.dualDeviceUsers
      // primary device
      const primary = await buildDevice(relay, identity, u, undefined)
      devices.push(primary)
      users.push({ identity, primaryDevice: primary })
      if (isDual) {
        // second device: SAME identity + shared keyManagement/metadata, fresh log/compact.
        const second = await buildDevice(relay, identity, u, primary.client)
        devices.push(second)
      }
      // staggered connect: small backoff every batch to avoid client-side WS dial saturation.
      if (u % 10 === 9) await wait(50)
    }
    log(`  ${devices.length} devices connected (${cfg.users} users, ${cfg.dualDeviceUsers} dual-device)`)

    // spaces: space 0 is the big festival group; the rest 8..12 members (seeded).
    log('phase 1: spaces + invites…')
    for (let s = 0; s < cfg.spaces; s++) {
      const creatorUserIndex = s % cfg.users
      const targetSize = s === 0 ? cfg.bigSpaceMembers : 8 + rngInt(rng, 5) // 8..12
      const memberSet = new Set<number>([creatorUserIndex])
      let guard = 0
      while (memberSet.size < Math.min(targetSize, cfg.users) && guard++ < cfg.users * 5) {
        memberSet.add(rngInt(rng, cfg.users))
      }
      const memberUserIndices = [...memberSet]
      const creatorClient = users[creatorUserIndex].primaryDevice.client
      const space = await creatorClient.adapter.createSpace<StressDoc>(
        'shared',
        { items: {}, _stressWrites: {} },
        { name: `stress-space-${s}` },
      )
      await wait(250) // let the space-register settle before inviting (mirrors the e2e helper)
      // invites are same-doc control frames → serialize per space.
      for (const m of memberUserIndices) {
        if (m === creatorUserIndex) continue
        const enc = await users[m].identity.getEncryptionPublicKeyBytes()
        await creatorClient.adapter.addMember(space.id, users[m].identity.getDid(), enc)
      }
      spaces.push({ spaceId: space.id, creatorUserIndex, memberUserIndices })
      log(`  space ${s} (${space.id.slice(0, 8)}) created by user ${creatorUserIndex}, ${memberUserIndices.length} members`)
    }
    // membership convergence: (a) PRIMARY member devices learn their spaces via passive invite
    // delivery; (b) dual-device SECOND devices share metadata but need an explicit requestSync to
    // load the space into their adapter registry (cold-start pattern). Nudge (b), then poll all.
    log('phase 1: waiting for invites to propagate to all member devices…')
    const primaries = devices.filter((d) => !d.isSecond)
    await waitForSpacesReady(primaries, spaces, CONVERGE_BUDGET_MS)
    // requestSync('__all__') runs restoreSpacesFromMetadata → discovers the spaces the shared
    // metadata already holds (requestSync(spaceId) is a no-op for a space not in the registry).
    for (const dev of devices.filter((d) => d.isSecond)) {
      await dev.client.adapter.requestSync('__all__').catch(() => {})
    }
    const spacesReady = await waitForSpacesReady(devices, spaces, CONVERGE_BUDGET_MS)
    if (!spacesReady) {
      notes.push('not all member devices could open their spaces within budget (invite propagation) — writes may under-count.')
      log('  WARNING: spaces not fully ready within budget')
      for (const sp of spaces) {
        const members = devices.filter((d) => !d.offline && sp.memberUserIndices.includes(d.userIndex))
        let ready = 0
        for (const dev of members) {
          const known = new Set((await dev.client.adapter.getSpaces()).map((s) => s.id))
          if (known.has(sp.spaceId)) ready += 1
        }
        log(`    space ${sp.spaceId.slice(0, 8)}: ${ready}/${members.length} member devices ready`)
      }
    } else {
      log('  all member devices can open their spaces')
    }
    // Snapshot errors after SETUP: membership/invite negotiation has its own benign relay-whitelist
    // churn (a non-queue-eligible frame the adapter falls back from). The zero-error GATE covers the
    // WRITE phases (warm-up/burst/catch-up), not setup — setup churn is reported separately.
    const postSetupErrors = sumErrorFrames(devices)

    // expected ledger: space → authorDeviceId → Set<writeId>
    const ledger = new Map<string, Map<string, Set<string>>>()
    for (const sp of spaces) ledger.set(sp.spaceId, new Map())
    const writeCounters = new Map<string, number>()

    const spacesForDevice = (dev: Device): SpacePlan[] =>
      spaces.filter((sp) => sp.memberUserIndices.includes(dev.userIndex))

    async function issueWrite(dev: Device, sp: SpacePlan, measure: boolean): Promise<string> {
      // openSpace + transact FIRST; only after the write is committed do we bump the counter and
      // record the writeId in the expected ledger — so a throwing openSpace/transact never advances
      // the counter or adds a phantom writeId (the rotation-canary proof depends on this).
      const n = (writeCounters.get(dev.deviceId) ?? 0) + 1
      const writeId = `${dev.deviceId}:${n}`
      const sentAt = Date.now()
      const handle = await dev.client.adapter.openSpace<StressDoc>(sp.spaceId)
      handle.transact((d: StressDoc) => {
        if (!d._stressWrites) d._stressWrites = {}
        d._stressWrites[writeId] = { authorDevice: dev.deviceId, sentAt }
      })
      writeCounters.set(dev.deviceId, n)
      let byAuthor = ledger.get(sp.spaceId)!.get(dev.deviceId)
      if (!byAuthor) {
        byAuthor = new Set<string>()
        ledger.get(sp.spaceId)!.set(dev.deviceId, byAuthor)
      }
      byAuthor.add(writeId)
      if (measure && latencySamples.length < LATENCY_SAMPLE_CAP) {
        void measureLatency(dev, sp, writeId, sentAt).catch(() => {})
      }
      return writeId
    }

    async function measureLatency(author: Device, sp: SpacePlan, writeId: string, sentAt: number): Promise<void> {
      // one co-member online receiver device (not the author)
      const receiver = devices.find(
        (d) => !d.offline && d.deviceId !== author.deviceId && sp.memberUserIndices.includes(d.userIndex),
      )
      if (!receiver) return
      const handle = await receiver.client.adapter.openSpace<StressDoc>(sp.spaceId)
      const ok = await waitFor(() => Boolean(handle.getDoc()._stressWrites?.[writeId]), { timeoutMs: CONVERGE_BUDGET_MS, stepMs: 25 })
      if (ok) latencySamples.push(Date.now() - sentAt)
    }

    // settle: let every device's per-space coordinator (esp. second devices loaded via
    // metadata-restore) finish wiring the write path before the first write.
    await wait(cfg.mode === 'S' ? 3_000 : 1_500)

    // ── PHASE 2: warm-up ─────────────────────────────────────────────────────────
    log('phase 2: warm-up (1 write/device/space)…')
    for (const dev of devices) {
      for (const sp of spacesForDevice(dev)) await issueWrite(dev, sp, false)
    }
    await wait(cfg.mode === 'S' ? 2_000 : 1_000)

    // ── PHASE 3: burst ───────────────────────────────────────────────────────────
    log(`phase 3: burst (${cfg.burstMsgsPerDevice} writes/device, seeded jitter)…`)
    const burstStart = Date.now()
    for (const dev of devices) {
      const devSpaces = spacesForDevice(dev)
      if (devSpaces.length === 0) continue
      for (let i = 0; i < cfg.burstMsgsPerDevice; i++) {
        const sp = devSpaces[rngInt(rng, devSpaces.length)]
        await issueWrite(dev, sp, i === 0) // measure the first write per device
        if (rng() < 0.2) await wait(rngInt(rng, 5)) // seeded jitter
      }
    }
    // convergence: every online device applied every expected writeId of its spaces.
    const convergeOk = await waitForConvergence(devices, spaces, ledger, CONVERGE_BUDGET_MS)
    convergence.timeToConvergeMs = convergeOk ? Date.now() - burstStart : null
    log(`  burst issued; converged=${convergeOk}`)
    // Convergence tally at the verified-good burst steady state (before offline/rotation churn).
    const burstConv = await tallyConvergence(devices, spaces, ledger)
    convergence.devicesChecked = burstConv.checked
    convergence.devicesConverged = burstConv.converged

    // ── PHASE 4: offline catch-up storm ──────────────────────────────────────────
    log(`phase 4: offline cohort ${cfg.offlineCohortPct}% disconnect…`)
    // COUNT-based selection (the old `i % 100 < pct` picked ALL devices offline on any run with
    // ≤100 devices → NO online cohort → the offline storm was never actually exercised). Guarantee a
    // NON-EMPTY online cohort (min with len-1) so there ARE online writes during the offline window;
    // seeded spread keeps it deterministic + distributed across users.
    const offlineCount =
      cfg.offlineCohortPct >= 100
        ? devices.length
        : Math.min(devices.length - 1, Math.round((devices.length * cfg.offlineCohortPct) / 100))
    const offlineIdx = new Set(
      [...devices.keys()]
        .map((i) => ({ i, r: rng() }))
        .sort((a, b) => a.r - b.r)
        .slice(0, Math.max(0, offlineCount))
        .map((x) => x.i),
    )
    const offlineCohort = devices.filter((_, i) => offlineIdx.has(i))
    log(`  ${offlineCohort.length}/${devices.length} offline; ${devices.length - offlineCohort.length} stay online and write during the storm`)
    for (const dev of offlineCohort) {
      // Fold this client's error tally into the durable accumulator BEFORE stop() swaps the probe —
      // otherwise the cohort's warm-up/burst error frames vanish from the zero-error gate.
      foldErrorsIntoAccum(dev)
      await dev.client.stop()
      dev.offline = true
    }
    // online cohort writes more while the cohort is away
    for (const dev of devices.filter((d) => !d.offline)) {
      for (const sp of spacesForDevice(dev)) await issueWrite(dev, sp, false)
    }
    await wait(500)
    // cohort reconnects simultaneously → time-to-converge
    const catchUpStart = Date.now()
    for (const dev of offlineCohort) {
      dev.client = await dev.makeReconnect()
      dev.offline = false
      reconnects.count += 1
      // catch up ALL of this device's spaces (requestSync(spaceId) only covers one).
      await dev.client.adapter.requestSync('__all__')
    }
    const catchUpOk = await waitForConvergence(offlineCohort, spaces, ledger, CONVERGE_BUDGET_MS)
    catchUpConvergeMs = catchUpOk ? Date.now() - catchUpStart : null
    log(`  cohort reconnected; converged=${catchUpOk} in ${catchUpConvergeMs}ms`)

    // Snapshot the error tally BEFORE rotation: steady-state (warm-up/burst/catch-up) must be
    // clean; the rotation phase deliberately induces rejects (stale cap/gen, revoked-device
    // frames) which are classified + reported, not hard-failed (as long as zero-loss holds).
    const preRotationErrors = sumErrorFrames(devices)

    // ── PHASE 5: rotation under load (one removal per space) ──────────────────────
    log('phase 5: one member-removal per space (rotation under load)…')
    for (const sp of spaces) {
      // choose a removable member: a NON-creator member user with at least one device.
      const removable = sp.memberUserIndices.find((u) => u !== sp.creatorUserIndex)
      if (removable === undefined) continue
      sp.removedUserIndex = removable
      const creatorClient = users[sp.creatorUserIndex].primaryDevice.client
      const removedDid = users[removable].identity.getDid()
      try {
        await creatorClient.adapter.removeMember(sp.spaceId, removedDid)
      } catch (err) {
        notes.push(`space ${sp.spaceId.slice(0, 8)}: removeMember threw ${(err as Error).message}`)
      }
    }
    await wait(cfg.mode === 'S' ? 3_000 : 1_500)

    // Positive: every remaining member device can WRITE on the new generation — proven by the
    // write CONVERGING to a co-member (not merely a counter bump, which advances even on failure).
    log('phase 5: verify remaining members write post-rotation…')
    let remainingWriteOk = true
    for (const sp of spaces) {
      const remainer = devices.find(
        (d) => !d.offline && d.userIndex !== sp.removedUserIndex && sp.memberUserIndices.includes(d.userIndex),
      )
      if (!remainer) continue
      let wid: string
      try {
        wid = await issueWrite(remainer, sp, false)
      } catch (err) {
        remainingWriteOk = false
        notes.push(`space ${sp.spaceId.slice(0, 8)}: remaining member ${remainer.deviceId.slice(0, 8)} could not write post-rotation (${(err as Error).message})`)
        continue
      }
      // real proof: the post-rotation write must reach ANOTHER remaining member on the new generation.
      const receiver = devices.find(
        (d) =>
          !d.offline &&
          d.deviceId !== remainer.deviceId &&
          d.userIndex !== sp.removedUserIndex &&
          sp.memberUserIndices.includes(d.userIndex),
      )
      if (receiver) {
        const rh = await receiver.client.adapter.openSpace<StressDoc>(sp.spaceId)
        const landed = await waitFor(() => Boolean(rh.getDoc()._stressWrites?.[wid]), { timeoutMs: 30_000, stepMs: 100 })
        if (!landed) {
          remainingWriteOk = false
          notes.push(`space ${sp.spaceId.slice(0, 8)}: post-rotation write ${wid.slice(-8)} did NOT converge to a co-member on the new generation`)
        }
      }
    }
    gates.remainingMembersWriteAfterRotation = remainingWriteOk

    // Negative: a removed member cannot read a post-rotation canary.
    log('phase 5: verify removed member reads nothing new…')
    let removedReadsNothing = true
    for (const sp of spaces) {
      if (sp.removedUserIndex === undefined) continue
      // creator writes a post-rotation canary
      const creatorDev = users[sp.creatorUserIndex].primaryDevice
      const canaryId = `canary:${sp.spaceId}:${Date.now()}`
      const handle = await creatorDev.client.adapter.openSpace<StressDoc>(sp.spaceId)
      handle.transact((d: StressDoc) => {
        if (!d._stressWrites) d._stressWrites = {}
        d._stressWrites[canaryId] = { authorDevice: creatorDev.deviceId, sentAt: Date.now() }
      })
      await wait(cfg.mode === 'S' ? 2_000 : 800)
      const removedDev = devices.find((d) => d.userIndex === sp.removedUserIndex)
      if (removedDev && !removedDev.offline) {
        const rHandle = await removedDev.client.adapter.openSpace<StressDoc>(sp.spaceId).catch(() => null)
        if (rHandle && rHandle.getDoc()._stressWrites?.[canaryId]) {
          removedReadsNothing = false
          notes.push(`space ${sp.spaceId.slice(0, 8)}: REMOVED member decrypted a post-rotation canary — LEAK`)
        }
      }
    }
    gates.removedMemberReadsNothing = removedReadsNothing

    // ── DRAIN: let KEY_GENERATION_STALE re-emits + propagation settle before auditing ──
    // Rotation-phase writes by remaining members are must-land, but the re-emit under the new
    // generation is async — auditing too soon reports a not-yet-landed re-emit as loss.
    log('draining re-emits + propagation before audit…')
    await wait(cfg.mode === 'S' ? 5_000 : 2_500)
    const finalConverged = await waitForConvergence(devices.filter((d) => !d.offline), spaces, ledger, 30_000)
    if (!finalConverged) {
      notes.push('some online devices still lacked a writeId LOCALLY at audit time (client-side propagation lag; the wire audit below is the authoritative zero-loss check).')
    }

    // ── PHASE 7: audit + report ──────────────────────────────────────────────────
    log('phase 7: wire-level zero-loss audit…')
    // devices that saw KEY_GENERATION_STALE → their seq gaps are "explained".
    const staleReemitDevices = new Set<string>()
    for (const dev of devices) {
      if (!dev.offline && (dev.client.probe.errorFramesByCode['KEY_GENERATION_STALE'] ?? 0) > 0) {
        staleReemitDevices.add(dev.deviceId)
      }
    }

    audit = []
    for (const sp of spaces) {
      const creator = users[sp.creatorUserIndex].primaryDevice.client
      const keys: SpaceKeyAccess = {
        currentGeneration: () => creator.keyManagement.getCurrentGeneration(sp.spaceId),
        capabilitySigningSeed: (g) => creator.keyManagement.getCapabilitySigningSeed(sp.spaceId, g),
        contentKey: (g) => creator.keyManagement.getKeyByGeneration(sp.spaceId, g),
      }
      const expected = new Set<string>()
      for (const set of ledger.get(sp.spaceId)!.values()) for (const id of set) expected.add(id)
      const result = await auditSpace({ relayUrl: cfg.relayUrl, spaceId: sp.spaceId, keys, expectedWriteIds: expected, staleReemitDevices })
      audit.push(result)
      if (result.missingWriteIds.length > 0) {
        const secondIds = new Set(devices.filter((d) => d.isSecond).map((d) => d.deviceId))
        const missingBySecond = result.missingWriteIds.filter((w) => secondIds.has(w.split(':')[0])).length
        log(`  space ${sp.spaceId.slice(0, 8)}: pulled ${result.entriesPulled}, missing ${result.missingWriteIds.length} (${missingBySecond} by second-devices)`)
      } else {
        log(`  space ${sp.spaceId.slice(0, 8)}: pulled ${result.entriesPulled}, missing 0`)
      }
    }

    // ── gates ────────────────────────────────────────────────────────────────────
    const totalMissing = audit.reduce((n, a) => n + a.missingWriteIds.length, 0)
    gates.zeroLoss = totalMissing === 0
    const errorTally = aggregateErrors(devices, postSetupErrors, preRotationErrors)
    // Gate on WRITE-PHASE unexpected errors only (setup + rotation rejects are classified churn).
    gates.zeroUnexpectedErrors = Object.keys(errorTally.unexpectedByCode).length === 0
    gates.processSurvived = true
    gates.passed =
      gates.processSurvived &&
      gates.zeroLoss &&
      gates.zeroUnexpectedErrors &&
      gates.removedMemberReadsNothing &&
      gates.remainingMembersWriteAfterRotation

    const clientSaturationSuspected = maxLagMs > SATURATION_LAG_MS
    if (clientSaturationSuspected) {
      notes.push(`client event-loop lag peaked at ${maxLagMs.toFixed(0)}ms > ${SATURATION_LAG_MS}ms — latencies are CLIENT-limited, not a relay measurement.`)
    }
    notes.push('120 in-process Node clients ≠ 120 handsets (no radio/doze/NAT — that is Spur B).')

    const resourcesEnd = await fetchResources(cfg.relayUrl)
    const report: StressReport = {
      stamp: cfg.stamp,
      mode: cfg.mode,
      config: cfg,
      gates,
      audit,
      convergence,
      errors: errorTally,
      baseline: {
        burstLatencyMs: percentiles(latencySamples),
        catchUpConvergeMs,
        resourcesStart,
        resourcesEnd,
        reconnects: reconnects.count,
        clientEventLoopLagMaxMs: maxLagMs,
        clientSaturationSuspected,
      },
      notes,
      wallClockMs: Date.now() - startedAt,
    }
    const { jsonPath, mdPath } = await writeReport(cfg.artifactsDir, report)
    log(`report written: ${jsonPath}`)
    log(`             md: ${mdPath}`)
    log(`GATES: ${gates.passed ? 'PASS ✅' : 'FAIL ❌'} (zeroLoss=${gates.zeroLoss}, zeroUnexpectedErrors=${gates.zeroUnexpectedErrors}, removedReadsNothing=${gates.removedMemberReadsNothing}, remainingWrite=${gates.remainingMembersWriteAfterRotation})`)

    // teardown
    await teardown(devices, relayProc)
    clearInterval(lagTimer)
    process.exit(gates.passed ? 0 : 1)
  } catch (err) {
    log(`FATAL: ${(err as Error).stack ?? String(err)}`)
    await teardown(devices, relayProc).catch(() => {})
    clearInterval(lagTimer)
    process.exit(2)
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function buildDevice(
  relay: StartedRelay,
  identity: Awaited<ReturnType<typeof makeIdentity>>,
  userIndex: number,
  shareFrom: YjsClient | undefined,
): Promise<Device> {
  const build = async (): Promise<YjsClient> =>
    makeYjsClient({
      relay,
      identity,
      ...(shareFrom ? { keyManagement: shareFrom.keyManagement, metadataStorage: shareFrom.metadataStorage } : {}),
    })
  const client = await build()
  const dev: Device = {
    deviceId: client.deviceId,
    client,
    userIndex,
    isSecond: shareFrom !== undefined,
    offline: false,
    errorFramesAccum: {},
    makeReconnect: async () => {
      // cold reconnect: reuse identity + all stores (retains deviceId + heads) → forces catch-up.
      return makeYjsClient({
        relay,
        identity,
        keyManagement: client.keyManagement,
        metadataStorage: client.metadataStorage,
        docLogStore: client.docLogStore,
        compactStore: client.compactStore,
      })
    },
  }
  return dev
}

async function waitForSpacesReady(devs: Device[], spaces: SpacePlan[], budgetMs: number): Promise<boolean> {
  // Read-only membership check via getSpaces() (openSpace throws on a not-yet-invited space and,
  // polled aggressively, interferes with invite processing). A space is "ready" for a member once
  // its invite has been processed into that device's known-spaces set.
  return waitFor(
    async () => {
      for (const dev of devs) {
        if (dev.offline) continue
        const known = new Set((await dev.client.adapter.getSpaces()).map((s) => s.id))
        for (const sp of spaces) {
          if (!sp.memberUserIndices.includes(dev.userIndex)) continue
          if (!known.has(sp.spaceId)) return false
        }
      }
      return true
    },
    { timeoutMs: budgetMs, stepMs: 500 },
  )
}

async function waitForConvergence(
  devs: Device[],
  spaces: SpacePlan[],
  ledger: Map<string, Map<string, Set<string>>>,
  budgetMs: number,
): Promise<boolean> {
  return waitFor(
    async () => {
      for (const dev of devs) {
        if (dev.offline) continue
        for (const sp of spaces) {
          if (!sp.memberUserIndices.includes(dev.userIndex)) continue
          if (dev.userIndex === sp.removedUserIndex) continue
          const expected = new Set<string>()
          for (const set of ledger.get(sp.spaceId)!.values()) for (const id of set) expected.add(id)
          const handle = await dev.client.adapter.openSpace<StressDoc>(sp.spaceId)
          const applied = handle.getDoc()._stressWrites ?? {}
          for (const id of expected) if (!(id in applied)) return false
        }
      }
      return true
    },
    { timeoutMs: budgetMs, stepMs: 200 },
  )
}

async function tallyConvergence(
  devs: Device[],
  spaces: SpacePlan[],
  ledger: Map<string, Map<string, Set<string>>>,
): Promise<{ checked: number; converged: number }> {
  let checked = 0
  let converged = 0
  for (const dev of devs) {
    if (dev.offline) continue
    checked += 1
    let ok = true
    for (const sp of spaces) {
      if (!sp.memberUserIndices.includes(dev.userIndex)) continue
      if (dev.userIndex === sp.removedUserIndex) continue
      const expected = new Set<string>()
      for (const set of ledger.get(sp.spaceId)!.values()) for (const id of set) expected.add(id)
      const handle = await dev.client.adapter.openSpace<StressDoc>(sp.spaceId)
      const applied = handle.getDoc()._stressWrites ?? {}
      for (const id of expected) if (!(id in applied)) ok = false
    }
    if (ok) converged += 1
  }
  return { checked, converged }
}

/** Fold the current client's error tally into the device's durable accumulator (survives reconnect). */
function foldErrorsIntoAccum(dev: Device): void {
  for (const [code, n] of Object.entries(dev.client.probe.errorFramesByCode)) {
    dev.errorFramesAccum[code] = (dev.errorFramesAccum[code] ?? 0) + n
  }
}

/**
 * Sum every device's error-frame tally = the durable accumulator (folded-in prior client instances)
 * PLUS the current client's live probe. This is reconnect-safe: an offline device that swapped its
 * client for a fresh probe still contributes its pre-disconnect errors via the accumulator.
 */
function sumErrorFrames(devs: Device[]): Record<string, number> {
  const byCode: Record<string, number> = {}
  for (const dev of devs) {
    for (const [code, n] of Object.entries(dev.errorFramesAccum)) {
      byCode[code] = (byCode[code] ?? 0) + n
    }
    for (const [code, n] of Object.entries(dev.client.probe.errorFramesByCode)) {
      byCode[code] = (byCode[code] ?? 0) + n
    }
  }
  return byCode
}

function diffErrors(later: Record<string, number>, earlier: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [code, n] of Object.entries(later)) {
    const delta = n - (earlier[code] ?? 0)
    if (delta > 0) out[code] = delta
  }
  return out
}

/**
 * Split the error tally into three windows: SETUP (membership/invite negotiation), WRITE-PHASE
 * (warm-up/burst/catch-up — the gated steady state), and ROTATION-PHASE (the deliberately-induced
 * rejects). Only WRITE-PHASE codes outside the expected set fail the gate.
 */
function aggregateErrors(
  devs: Device[],
  postSetupErrors: Record<string, number>,
  preRotationErrors: Record<string, number>,
): StressReport['errors'] {
  const expectedCodes = [
    'KEY_GENERATION_STALE',
    'CAPABILITY_GENERATION_STALE',
    'DEVICE_REVOKED',
    'CAPABILITY_EXPIRED',
    // The dead legacy content/full-state channel is correctly rejected by the relay whitelist
    // (Legacy Isolation — convergence rides the log path; not a data-loss path).
    'MALFORMED_MESSAGE(content-channel-not-queue-eligible)',
  ]
  const byCode = sumErrorFrames(devs)
  const setupByCode = { ...postSetupErrors }
  const steadyStateByCode = diffErrors(preRotationErrors, postSetupErrors)
  const rotationPhaseByCode = diffErrors(byCode, preRotationErrors)
  // Gate: only WRITE-PHASE codes outside the expected set are real problems.
  const unexpectedByCode: Record<string, number> = {}
  for (const [code, n] of Object.entries(steadyStateByCode)) {
    if (!expectedCodes.includes(code)) unexpectedByCode[code] = n
  }
  return { byCode, setupByCode, steadyStateByCode, rotationPhaseByCode, unexpectedByCode, expectedCodes }
}

async function teardown(devices: Device[], relayProc: RelayProcess | null): Promise<void> {
  for (const dev of devices) {
    if (!dev.offline) await dev.client.stop().catch(() => {})
  }
  if (relayProc) await relayProc.stop().catch(() => {})
}

void main().catch((err) => {
  // Backstop for anything thrown outside main()'s structured try (e.g. config parsing).
  // eslint-disable-next-line no-console
  console.error(`[stress] FATAL (outer): ${(err as Error).stack ?? String(err)}`)
  process.exit(2)
})
