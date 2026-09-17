import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const appMock = {
  disableHardwareAcceleration: vi.fn(),
  commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn() },
  once: vi.fn()
}

vi.mock('electron', () => ({ app: appMock }))

describe('Real Xvfb Stale Lock Container Verification', () => {
  const DISPLAY_NUM = 99
  const LOCK_FILE = `/tmp/.X${DISPLAY_NUM}-lock`
  const SOCK_FILE = `/tmp/.X11-unix/X${DISPLAY_NUM}`

  beforeEach(() => {
    try {
      fs.rmSync(LOCK_FILE, { force: true })
      fs.rmSync(SOCK_FILE, { force: true })
    } catch {}
    delete process.env.DISPLAY
  })

  afterEach(async () => {
    const { stopVirtualDisplay } = await import('./ensure-virtual-display')
    stopVirtualDisplay()
    try {
      fs.rmSync(LOCK_FILE, { force: true })
      fs.rmSync(SOCK_FILE, { force: true })
    } catch {}
    delete process.env.DISPLAY
  })

  it('detects orphan stale lock with dead PID and no socket', async () => {
    const { isStaleDisplayLock } = await import('./ensure-virtual-display')
    fs.writeFileSync(LOCK_FILE, '999999\n')
    expect(fs.existsSync(SOCK_FILE)).toBe(false)
    expect(isStaleDisplayLock(DISPLAY_NUM)).toBe(true)
  })

  it('reaps orphan stale lock and allows real Xvfb to start cleanly', async () => {
    const { isStaleDisplayLock, ensureVirtualDisplayForHeadlessServe } =
      await import('./ensure-virtual-display')

    // 1. Create orphan lock with dead PID and ensure no socket exists
    fs.writeFileSync(LOCK_FILE, '999999\n')
    expect(fs.existsSync(SOCK_FILE)).toBe(false)
    expect(isStaleDisplayLock(DISPLAY_NUM)).toBe(true)

    // 2. Call ensureVirtualDisplayForHeadlessServe
    const started = ensureVirtualDisplayForHeadlessServe({ isServeMode: true })
    expect(started).toBe(true)
    expect(process.env.DISPLAY).toBe(`:${DISPLAY_NUM}`)

    // 3. Verify Xvfb started and wrote a new lock file with active PID
    expect(fs.existsSync(LOCK_FILE)).toBe(true)
    const newPid = Number.parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10)
    expect(newPid).toBeGreaterThan(0)
    expect(newPid).not.toBe(999999)

    // 4. Verify socket was created
    expect(fs.existsSync(SOCK_FILE)).toBe(true)
  })
})
