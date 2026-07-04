/**
 * Festival-Scale-Stress — PROD-GUARD (hard, no override).
 *
 * The stress runner drives DESTRUCTIVE traffic (member-removals → key-rotations,
 * write bursts). It must NEVER touch a production relay. This guard parses the
 * target URL HOST-based (via `new URL()`, so ws/wss/http/https all normalize to the
 * same hostname) and is FAIL-CLOSED: only an explicit allowlist of disposable hosts
 * is permitted; anything else — including the two known prod hosts — aborts the run.
 *
 * There is deliberately NO override flag.
 */

/** Known production relay hosts — always refused (belt-and-suspenders on top of the allowlist). */
export const PROD_RELAY_HOSTS = ['relay.web-of-trust.de', 'relay.utopia-lab.org'] as const

/** The ONLY hosts a stress run may target. Fail-closed: not on this list → refused. */
export const ALLOWED_RELAY_HOSTS = ['localhost', '127.0.0.1', '::1', 'relay-staging.web-of-trust.de'] as const

export class ProdGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProdGuardError'
  }
}

/**
 * Throw unless `targetUrl` points at an allowlisted disposable relay. Host-based, so
 * `ws://`, `wss://`, `http://` and `https://` variants of the same host are treated
 * identically. Called before ANY connection/spawn.
 */
export function assertNotProdRelay(targetUrl: string): void {
  let host: string
  try {
    host = new URL(targetUrl).hostname
  } catch {
    throw new ProdGuardError(`PROD-GUARD: relay URL is unparseable, refusing: ${JSON.stringify(targetUrl)}`)
  }
  // URL().hostname keeps IPv6 brackets ([::1]); strip them so the allowlist matches.
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if ((PROD_RELAY_HOSTS as readonly string[]).includes(normalized)) {
    throw new ProdGuardError(
      `PROD-GUARD: refusing to run destructive stress against PRODUCTION relay host "${normalized}". ` +
        `This is not overridable.`,
    )
  }
  if (!(ALLOWED_RELAY_HOSTS as readonly string[]).includes(normalized)) {
    throw new ProdGuardError(
      `PROD-GUARD: relay host "${normalized}" is not on the disposable allowlist ` +
        `[${ALLOWED_RELAY_HOSTS.join(', ')}]. Refusing (fail-closed).`,
    )
  }
}
