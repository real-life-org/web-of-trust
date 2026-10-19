// Simulation adapter (architecture §3.2). Only the harness target loads it, through a dynamic
// import in app/compose.ts; store builds are checked for its absence (scripts/check-build.mjs).

export { createSimWorld, SIM_MARKER } from './world'
export type { SimWorld, SimOptions, WorldAction } from './world'
export { createSimPort } from './port'
export type * from './seed'
export { simHolderHost, simDatabaseNames } from './holder'
export type { SimHolders, SimHolderRecord } from './holder'
