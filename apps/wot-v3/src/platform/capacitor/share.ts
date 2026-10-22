// Native share sheet and mail draft (architecture §5 table: @capacitor/share; the mail composer of the
// report, paper §6). Never throw.

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { EmailComposer } from 'capacitor-email-composer'
import type { MailPort, SharePort } from '../ports'

/** The share sheet answers a dismissal with an error whose message says "cancel" (Android and iOS). */
const cancelled = (e: unknown) => /cancel/i.test(e instanceof Error ? e.message : String(e))

/** Shared files live here only for the hand-over: removed after it, and swept before every new one. */
const SHARE_DIR = 'wot-share'

/** The folder is not there (the plugin's message on Android and iOS): nothing left, nothing to remove. */
const missing = (e: unknown) => /does not exist|doesn't exist|no such|not found/i.test(e instanceof Error ? e.message : String(e))

/** Removes every file left for a hand-over (also one a crash left behind; delete inventory, session
 *  layers). true only when the folder is gone; any other failure is reported, never taken as clean. */
export async function sweepShared(): Promise<boolean> {
  try {
    await Filesystem.rmdir({ path: SHARE_DIR, directory: Directory.Cache, recursive: true })
    return true
  } catch (e) {
    return missing(e)
  }
}

/** Files still waiting in the hand-over folder (verification of a delete); a folder that cannot be
 *  read is a survivor too. */
export async function sharedSurvivors(): Promise<string[]> {
  try {
    return (await Filesystem.readdir({ path: SHARE_DIR, directory: Directory.Cache })).files.map((f) => `share-file:${f.name}`)
  } catch (e) {
    return missing(e) ? [] : ['share-dir:unverifiable']
  }
}

const sweep = sweepShared
/** a second try right away for a transient refusal */
const sweepAgain = async () => (await sweepShared()) || (await sweepShared())

export const capacitorShare: SharePort = {
  async share({ text, url }) {
    try {
      if (!(await Share.canShare()).value) return 'unsupported'
      await Share.share({ text, ...(url ? { url } : {}) })
      return 'shared'
    } catch (e) {
      return cancelled(e) ? 'cancelled' : 'unsupported'
    }
  },
  async shareFile({ name, text, title, body }) {
    try {
      if (!(await Share.canShare()).value) return 'unsupported'
    } catch {
      return 'unsupported'
    }
    // a folder that cannot be emptied takes no new report (review 432 R2-3)
    if (!(await sweep())) return 'unsupported'
    let handed = false
    try {
      const safe = name.replace(/[^\w.-]+/g, '_') || 'report.txt'
      const { uri } = await Filesystem.writeFile({ path: `${SHARE_DIR}/${safe}`, data: text, directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true })
      await Share.share({ title, ...(body ? { text: body } : {}), files: [uri], dialogTitle: title })
      handed = true
    } catch (e) {
      if (cancelled(e)) return (await sweepAgain()) ? 'cancelled' : 'unsupported'
      await sweepAgain()
      return 'unsupported'
    }
    // the app keeps no copy of the file after the hand-over (SharePort.shareFile); a file that stays
    // means the hand-over is not reported as done (the next start sweeps again, a delete reports it)
    return handed && (await sweepAgain()) ? 'shared' : 'unsupported'
  },
}

/** The system mail composer; 'unavailable' when the device has no mail account (the screen then offers
 *  copying, paper §6 step 5). */
export const capacitorMail: MailPort = {
  async compose({ to, subject, body }) {
    try {
      if (!(await EmailComposer.hasAccount()).hasAccount) return 'unavailable'
      await EmailComposer.open({ to: [to], subject, body, isHtml: false })
      return 'opened'
    } catch {
      return 'unavailable'
    }
  },
}
