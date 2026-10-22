// a hook reaching a native API over a re-export directly under platform/ (review 432 R3-4)
import { Clipboard } from '../platform/bridge'
export const x = Clipboard
