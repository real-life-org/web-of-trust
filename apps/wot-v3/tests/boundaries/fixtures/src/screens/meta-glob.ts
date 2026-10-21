// import.meta.glob turns into imports nobody checks (review 432 R2-5)
export const modules = import.meta.glob('../platform/capacitor/*.ts', { eager: true })
