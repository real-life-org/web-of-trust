// template-literal import with a variable: its target cannot be checked
export const load = (name: string) => import(`../adapters/${name}/index.ts`)
