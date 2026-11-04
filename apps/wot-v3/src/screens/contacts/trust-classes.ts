// The trust classes the details and the trust question list (Anton 04.11.); one module both read, so
// neither imports the other.
import type { TrustClass } from '../../port'

/** the classes a person sets here, in the order of the list: the anchor first (the trust itself), then
 *  what a person can see and decide on (Anton 04.11.: anchor, profile, group identities). The blinded
 *  stars of contacts and groups are not listed: they reveal no identity (Trust 5.1, intersection only)
 *  and keep following the trust */
export const TRUST_CLASSES: readonly TrustClass[] = ['anchorMapping', 'profile', 'sealedGroupStar']

/** the star classes, listed in the details only once set away from following the trust (review 504):
 *  a choice made earlier stays reachable, so the person can undo it */
export const STAR_CLASSES: readonly TrustClass[] = ['star', 'groupStar']
