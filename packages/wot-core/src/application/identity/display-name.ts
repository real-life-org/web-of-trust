/**
 * Generate a short display name from a DID
 * Format: "User-{6chars}" from the end of the DID
 */
export function getDefaultDisplayName(did: string): string {
  if (!did) return 'User'
  const suffix = did.slice(-6)
  return `User-${suffix}`
}
