// app code must not reach the harness, not even through a dynamic import (only app/compose.ts may)
export const load = () => import('../../harness/player/player.ts')
