// What a contact id stands for changes in the holder's incoming and duty work (a chaining after a second
// meeting, Trust 6a.4; a merge, 2140): `receive`, `tick`, `resume`. An attempt of the contact order reads
// what its contact stands for and acts on it (CONTACT-ORDER.md "A contact joined meanwhile"); between that
// reading and the act no such work may run, or the act would meet another person than the one it read.
// The write gate counts calls and does not order them, so this turn does: the holder's joining work shares
// it, an ordered attempt has it alone. A waiting attempt goes before joining work that comes after it.

export interface ContactTurn {
  /** the holder's work that can join contacts: runs with other such work, never during an attempt */
  joining<T>(fn: () => Promise<T>): Promise<T>
  /** an ordered attempt, reading and act: alone */
  attempt<T>(fn: () => Promise<T>): Promise<T>
}

export function createContactTurn(): ContactTurn {
  let joining = 0
  let attempting = false
  let wanted = 0
  let waiting: (() => void)[] = []
  const wake = () => {
    const w = waiting
    waiting = []
    for (const r of w) r()
  }
  const wait = () => new Promise<void>((r) => waiting.push(r))
  return {
    async joining(fn) {
      // the condition is read again after every wait, and the count taken in the same turn
      while (attempting || wanted > 0) await wait()
      joining++
      try {
        return await fn()
      } finally {
        joining--
        wake()
      }
    },
    async attempt(fn) {
      wanted++
      while (attempting || joining > 0) await wait()
      wanted--
      attempting = true
      try {
        return await fn()
      } finally {
        attempting = false
        wake()
      }
    },
  }
}
