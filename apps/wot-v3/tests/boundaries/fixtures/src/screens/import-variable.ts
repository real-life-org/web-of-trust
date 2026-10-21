// a dynamic import over a name: no tool can see its target (review 432 R1-9)
const plugin = '@capacitor/app'
export const load = () => import(plugin)
export const load2 = () => import('@capacitor/' + 'app')
