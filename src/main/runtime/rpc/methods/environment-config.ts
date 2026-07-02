// Why: Feature #9 lets a paired client read and edit the *server* runtime's
// portable behavior settings over the already-authenticated E2EE channel
// (design: orca/design/feature-09-remote-server-settings-cli.md). The zod
// `.strict()` schema below IS the privilege boundary — it is an ALLOWLIST of
// portable runtime-behavior keys, enforced server-side in `setMany`. A key that
// is not listed here is rejected at the RPC boundary, so the surface is
// safe-by-default: newly added `GlobalSettings` keys stay unreachable until a
// human explicitly adds them (design §4.2). Host-binding, command-exec-adjacent,
// proxy/network-redirect, credential, and destructive-guard keys are
// deliberately excluded (design §4.1) — see the excluded-key rationale in the
// feature design before widening this schema.
import { z } from 'zod'
import type { GlobalSettings } from '../../../../shared/types'
import { defineMethod, type RpcMethod } from '../core'

// Why: keeping the shape as a plain object (rather than reading `.shape` off the
// built schema) gives one canonical key list that both the zod validator and the
// runtime read-projection derive from, so they cannot drift apart.
const portableSettingsShape = {
  // Appearance / editor
  theme: z.enum(['system', 'dark', 'light']).optional(),
  appFontFamily: z.string().optional(),
  editorAutoSave: z.boolean().optional(),
  editorAutoSaveDelayMs: z.number().finite().optional(),
  editorMinimapEnabled: z.boolean().optional(),
  markdownReviewToolsEnabled: z.boolean().optional(),
  primarySelectionMiddleClickPaste: z.boolean().optional(),
  // Terminal rendering / appearance (the poster-child divergence keys)
  terminalFontSize: z.number().finite().optional(),
  terminalFontFamily: z.string().optional(),
  terminalFontWeight: z.number().finite().optional(),
  terminalLineHeight: z.number().finite().optional(),
  terminalGpuAcceleration: z.enum(['auto', 'on', 'off']).optional(),
  terminalLigatures: z.enum(['auto', 'on', 'off']).optional(),
  terminalCursorStyle: z.enum(['bar', 'block', 'underline']).optional(),
  terminalCursorBlink: z.boolean().optional(),
  terminalThemeDark: z.string().optional(),
  terminalDividerColorDark: z.string().optional(),
  terminalUseSeparateLightTheme: z.boolean().optional(),
  terminalThemeLight: z.string().optional(),
  terminalDividerColorLight: z.string().optional(),
  terminalInactivePaneOpacity: z.number().finite().optional(),
  terminalActivePaneOpacity: z.number().finite().optional(),
  terminalPaneOpacityTransitionMs: z.number().finite().optional(),
  terminalDividerThicknessPx: z.number().finite().optional(),
  terminalBackgroundOpacity: z.number().finite().optional(),
  terminalPaddingX: z.number().finite().optional(),
  terminalPaddingY: z.number().finite().optional(),
  terminalMouseHideWhileTyping: z.boolean().optional(),
  terminalWordSeparator: z.string().optional(),
  terminalCursorOpacity: z.number().finite().optional(),
  windowBackgroundBlur: z.boolean().optional(),
  terminalRightClickToPaste: z.boolean().optional(),
  terminalFocusFollowsMouse: z.boolean().optional(),
  terminalScrollbackBytes: z.number().finite().optional(),
  terminalMacOptionAsAlt: z.enum(['auto', 'true', 'false', 'left', 'right']).optional(),
  terminalJISYenToBackslash: z.boolean().optional(),
  terminalScopeHistoryByWorktree: z.boolean().optional(),
  // UI layout / chrome
  showGitIgnoredFiles: z.boolean().optional(),
  sourceControlViewMode: z.enum(['list', 'tree']).optional(),
  showTitlebarAppName: z.boolean().optional(),
  showTasksButton: z.boolean().optional(),
  showAutomationsButton: z.boolean().optional(),
  showMobileButton: z.boolean().optional(),
  ctrlTabOrderMode: z.enum(['mru', 'sequential']).optional(),
  terminalShortcutPolicy: z.enum(['orca-first', 'terminal-first']).optional(),
  diffDefaultView: z.enum(['inline', 'side-by-side']).optional(),
  combinedDiffFileTreeVisibleByDefault: z.boolean().optional(),
  floatingTerminalTriggerLocation: z.enum(['floating-button', 'status-bar']).optional(),
  // Benign behavior toggles (no host/exec/network/credential footprint)
  tabAutoGenerateTitle: z.boolean().optional(),
  promptCacheTimerEnabled: z.boolean().optional(),
  promptCacheTtlMs: z.number().finite().optional(),
  // Cosmetic / UI experimental toggles
  experimentalPet: z.boolean().optional(),
  experimentalActivity: z.boolean().optional(),
  experimentalTerminalAttention: z.boolean().optional(),
  experimentalCompactWorktreeCards: z.boolean().optional()
} as const

export const PortableSettingsUpdate = z.object(portableSettingsShape).strict()

export type PortableSettingsPatch = z.infer<typeof PortableSettingsUpdate>

export type PortableSettingsKey = keyof PortableSettingsPatch

export type PortableSettings = Partial<Pick<GlobalSettings, PortableSettingsKey>>

// Why: the runtime read-projection iterates this list to return only allowlisted
// keys, so it stays in lockstep with the write-side validator above.
export const PORTABLE_SETTINGS_KEYS = Object.keys(portableSettingsShape) as PortableSettingsKey[]

export const ENVIRONMENT_CONFIG_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'environment.config.getAll',
    params: null,
    handler: (_params, { runtime }) => ({ settings: runtime.getPortableSettings() })
  }),
  defineMethod({
    name: 'environment.config.setMany',
    params: PortableSettingsUpdate,
    handler: (params, { runtime }) => ({ settings: runtime.updatePortableSettings(params) })
  })
]
