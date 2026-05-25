import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  accessMock,
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  handleMock,
  isTrustedAccessibilityClientMock,
  openExternalMock
} = vi.hoisted(() => ({
  accessMock: vi.fn(),
  askForMediaAccessMock: vi.fn(),
  getMediaAccessStatusMock: vi.fn(),
  handleMock: vi.fn(),
  isTrustedAccessibilityClientMock: vi.fn(),
  openExternalMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  access: accessMock
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    openExternal: openExternalMock
  },
  systemPreferences: {
    askForMediaAccess: askForMediaAccessMock,
    getMediaAccessStatus: getMediaAccessStatusMock,
    isTrustedAccessibilityClient: isTrustedAccessibilityClientMock
  }
}))

import { registerDeveloperPermissionHandlers } from './developer-permissions'

describe('registerDeveloperPermissionHandlers', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    accessMock.mockReset()
    askForMediaAccessMock.mockReset()
    getMediaAccessStatusMock.mockReset()
    getMediaAccessStatusMock.mockReturnValue('not-determined')
    handleMock.mockReset()
    isTrustedAccessibilityClientMock.mockReset()
    isTrustedAccessibilityClientMock.mockReturnValue(false)
    openExternalMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('keeps full-disk-access status passive', async () => {
    registerDeveloperPermissionHandlers()

    const handler = registeredHandler('developerPermissions:getStatus')
    const result = await handler()

    expect(result).toContainEqual({ id: 'full-disk-access', status: 'unknown' })
    expect(accessMock).not.toHaveBeenCalled()
  })

  it('opens Full Disk Access settings without probing protected files', async () => {
    registerDeveloperPermissionHandlers()

    const handler = registeredHandler('developerPermissions:request')
    await expect(handler(null, { id: 'full-disk-access' })).resolves.toEqual({
      id: 'full-disk-access',
      status: 'unknown',
      openedSystemSettings: true
    })

    expect(openExternalMock).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    )
    expect(accessMock).not.toHaveBeenCalled()
  })
})

function registeredHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const registration = handleMock.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  )
  if (!registration) {
    throw new Error(`Handler ${channel} was not registered`)
  }
  return registration[1] as (...args: unknown[]) => Promise<unknown>
}
