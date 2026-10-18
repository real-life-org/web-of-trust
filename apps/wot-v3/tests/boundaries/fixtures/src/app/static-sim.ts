// the app reaches the simulation only through a dynamic import in compose.ts
import { createSimWorld } from '../adapters/sim/index.ts'
export const x = createSimWorld
