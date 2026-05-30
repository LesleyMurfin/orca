import { useEffect, useState } from 'react'

export type WindowsTerminalCapabilities = {
  wslAvailable: boolean
  wslDistros: string[]
  pwshAvailable: boolean
  hostPlatform: NodeJS.Platform | null
  isLoading: boolean
}

const UNAVAILABLE_CAPABILITIES: WindowsTerminalCapabilities = {
  wslAvailable: false,
  wslDistros: [],
  pwshAvailable: false,
  hostPlatform: null,
  isLoading: false
}

const CAPABILITY_CACHE_TTL_MS = 30_000
const DEFAULT_CAPABILITY_CACHE_KEY = 'host'
let cachedCapabilitiesByKey = new Map<
  string,
  { capabilities: WindowsTerminalCapabilities; loadedAt: number }
>()
let pendingCapabilitiesByKey = new Map<string, Promise<WindowsTerminalCapabilities>>()
let latestCapabilityRequestIdByKey = new Map<string, number>()
const subscribersByKey = new Map<string, Set<(capabilities: WindowsTerminalCapabilities) => void>>()

function getSubscribers(
  cacheKey: string
): Set<(capabilities: WindowsTerminalCapabilities) => void> {
  let subscribers = subscribersByKey.get(cacheKey)
  if (!subscribers) {
    subscribers = new Set()
    subscribersByKey.set(cacheKey, subscribers)
  }
  return subscribers
}

function publish(
  cacheKey: string,
  capabilities: WindowsTerminalCapabilities,
  loadedAt = Date.now()
): void {
  cachedCapabilitiesByKey.set(cacheKey, { capabilities, loadedAt })
  for (const subscriber of getSubscribers(cacheKey)) {
    subscriber(capabilities)
  }
}

export function getCachedWindowsTerminalCapabilities(
  cacheKey = DEFAULT_CAPABILITY_CACHE_KEY
): WindowsTerminalCapabilities {
  return cachedCapabilitiesByKey.get(cacheKey)?.capabilities ?? UNAVAILABLE_CAPABILITIES
}

export function loadWindowsTerminalCapabilities(
  options: {
    force?: boolean
    now?: number
    cacheKey?: string
  } = {}
): Promise<WindowsTerminalCapabilities> {
  const now = options.now ?? Date.now()
  const cacheKey = options.cacheKey ?? DEFAULT_CAPABILITY_CACHE_KEY
  const cachedCapabilities = cachedCapabilitiesByKey.get(cacheKey)
  if (
    cachedCapabilities &&
    !options.force &&
    now - cachedCapabilities.loadedAt < CAPABILITY_CACHE_TTL_MS
  ) {
    return Promise.resolve(cachedCapabilities.capabilities)
  }
  const pendingCapabilities = pendingCapabilitiesByKey.get(cacheKey)
  if (pendingCapabilities && !options.force) {
    return pendingCapabilities
  }

  // Why: Settings, status bar, and paired web tab bars need one shared answer.
  // Separate probes can leave one surface showing stale Windows shell choices.
  const requestId = (latestCapabilityRequestIdByKey.get(cacheKey) ?? 0) + 1
  latestCapabilityRequestIdByKey.set(cacheKey, requestId)
  const nextPendingCapabilities = Promise.all([
    window.api.wsl.isAvailable().catch(() => false),
    window.api.wsl.listDistros().catch(() => []),
    window.api.pwsh.isAvailable().catch(() => false),
    window.api.runtime
      .getStatus()
      .then((status) => status.hostPlatform ?? null)
      .catch(() => null)
  ])
    .then(([wslAvailable, wslDistros, pwshAvailable, hostPlatform]) => {
      const capabilities = {
        wslAvailable,
        wslDistros,
        pwshAvailable,
        hostPlatform,
        isLoading: false
      }
      if (requestId === latestCapabilityRequestIdByKey.get(cacheKey)) {
        pendingCapabilitiesByKey.delete(cacheKey)
        publish(cacheKey, capabilities, now)
        return capabilities
      }
      return getCachedWindowsTerminalCapabilities(cacheKey)
    })
    .catch(() => {
      if (requestId === latestCapabilityRequestIdByKey.get(cacheKey)) {
        pendingCapabilitiesByKey.delete(cacheKey)
        publish(cacheKey, UNAVAILABLE_CAPABILITIES, now)
        return UNAVAILABLE_CAPABILITIES
      }
      return getCachedWindowsTerminalCapabilities(cacheKey)
    })

  pendingCapabilitiesByKey.set(cacheKey, nextPendingCapabilities)
  return nextPendingCapabilities
}

export function refreshWindowsTerminalCapabilities(): Promise<WindowsTerminalCapabilities> {
  return loadWindowsTerminalCapabilities({ force: true })
}

export function useWindowsTerminalCapabilities(
  enabled: boolean,
  forceRefreshOnMount = false,
  cacheKey = DEFAULT_CAPABILITY_CACHE_KEY
): WindowsTerminalCapabilities {
  const [capabilityState, setCapabilityState] = useState(() => ({
    cacheKey,
    capabilities: getCachedWindowsTerminalCapabilities(cacheKey)
  }))

  useEffect(() => {
    if (!enabled) {
      setCapabilityState({ cacheKey, capabilities: UNAVAILABLE_CAPABILITIES })
      return
    }

    const cached = getCachedWindowsTerminalCapabilities(cacheKey)
    setCapabilityState({
      cacheKey,
      capabilities: cachedCapabilitiesByKey.has(cacheKey) ? cached : { ...cached, isLoading: true }
    })
    const subscribers = getSubscribers(cacheKey)
    const setScopedCapabilities = (capabilities: WindowsTerminalCapabilities): void => {
      setCapabilityState({ cacheKey, capabilities })
    }
    subscribers.add(setScopedCapabilities)
    void loadWindowsTerminalCapabilities({ force: forceRefreshOnMount, cacheKey }).then(
      setScopedCapabilities
    )

    return () => {
      subscribers.delete(setScopedCapabilities)
    }
  }, [cacheKey, enabled, forceRefreshOnMount])

  if (!enabled) {
    return UNAVAILABLE_CAPABILITIES
  }
  return capabilityState.cacheKey === cacheKey
    ? capabilityState.capabilities
    : getCachedWindowsTerminalCapabilities(cacheKey)
}

export function resetWindowsTerminalCapabilitiesForTests(): void {
  cachedCapabilitiesByKey = new Map()
  pendingCapabilitiesByKey = new Map()
  latestCapabilityRequestIdByKey = new Map()
  subscribersByKey.clear()
}
