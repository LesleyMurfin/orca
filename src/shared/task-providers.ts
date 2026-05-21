export type TaskProvider = 'github' | 'gitlab' | 'linear'

export const TASK_PROVIDERS: readonly TaskProvider[] = ['github', 'gitlab', 'linear']

const TASK_PROVIDER_SET = new Set<TaskProvider>(TASK_PROVIDERS)

export function normalizeVisibleTaskProviders(value: unknown): TaskProvider[] {
  if (!Array.isArray(value)) {
    return [...TASK_PROVIDERS]
  }

  const normalized: TaskProvider[] = []
  for (const provider of value) {
    if (!TASK_PROVIDER_SET.has(provider as TaskProvider)) {
      continue
    }
    if (!normalized.includes(provider as TaskProvider)) {
      normalized.push(provider as TaskProvider)
    }
  }

  // Why: at least one provider must remain visible so the Tasks surface always
  // has a valid source to select after settings hydration or manual edits.
  return normalized.length > 0 ? normalized : [...TASK_PROVIDERS]
}

export type TaskProviderAvailability = {
  gitlabInstalled: boolean
  linearConnected: boolean
}

export function filterAvailableTaskProviders(
  visibleProviders: readonly TaskProvider[],
  availability: TaskProviderAvailability,
  preferredProvider?: TaskProvider | null
): TaskProvider[] {
  const normalizedPreferredProvider =
    preferredProvider && TASK_PROVIDER_SET.has(preferredProvider) ? preferredProvider : null
  const isProviderAvailable = (provider: TaskProvider): boolean => {
    if (provider === 'github') {
      return true
    }
    if (provider === 'gitlab') {
      return availability.gitlabInstalled
    }
    return availability.linearConnected
  }

  const available = visibleProviders.filter(isProviderAvailable)

  // Why: older or drifted settings can hide the saved default while another
  // provider becomes available. Keep that default reachable after hydration.
  if (
    normalizedPreferredProvider &&
    isProviderAvailable(normalizedPreferredProvider) &&
    !available.includes(normalizedPreferredProvider)
  ) {
    return TASK_PROVIDERS.filter(
      (provider) => provider === normalizedPreferredProvider || available.includes(provider)
    )
  }

  return available.length > 0 ? available : ['github']
}

export function resolveVisibleTaskProvider(
  preferred: TaskProvider | null | undefined,
  visibleProviders: readonly TaskProvider[]
): TaskProvider {
  if (preferred && visibleProviders.includes(preferred)) {
    return preferred
  }
  return visibleProviders[0] ?? 'github'
}
