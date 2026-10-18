// React bridge: the composition (port, platform, nav) reaches hooks through one context.
import { createContext, useContext, type ReactNode } from 'react'
import type { AppPort } from '../port'
import type { Platform } from '../platform/ports'
import type { NavStore } from '../app/nav'

export interface AppContextValue {
  readonly port: AppPort
  readonly platform: Platform
  readonly nav: NavStore
}

const Ctx = createContext<AppContextValue | null>(null)

export function AppContextProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function useApp(): AppContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('hook used outside AppContextProvider')
  return v
}

export function usePort(): AppPort {
  return useApp().port
}

export function usePlatform(): Platform {
  return useApp().platform
}

export function useNavStore(): NavStore {
  return useApp().nav
}
