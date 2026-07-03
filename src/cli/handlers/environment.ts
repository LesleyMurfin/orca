import type { CommandHandler } from '../dispatch'
import { formatEnvironment, formatEnvironmentList, printResult } from '../format'
import { getDefaultUserDataPath } from '../runtime-client'
import type { RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import { redactRuntimeEnvironment } from '../../shared/runtime-environments'
import {
  addEnvironmentFromPairingCode,
  listEnvironments,
  removeEnvironment,
  resolveEnvironment,
  type EnvironmentAddResult,
  type EnvironmentRemoveResult
} from '../runtime/environments'

export const ENVIRONMENT_HANDLERS: Record<string, CommandHandler> = {
  'environment add': async ({ flags, json }) => {
    const name = getRequiredStringFlag(flags, 'name')
    const pairingCode = getRequiredStringFlag(flags, 'pairing-code')
    const environment = redactRuntimeEnvironment(
      addEnvironmentFromPairingCode(getDefaultUserDataPath(), {
        name,
        pairingCode
      })
    )
    printResult(
      localSuccess({ environment }),
      json,
      (result: EnvironmentAddResult) =>
        `Saved environment ${result.environment.name} (${result.environment.id}).`
    )
  },
  'environment list': async ({ json }) => {
    const environments = listEnvironments(getDefaultUserDataPath()).map(redactRuntimeEnvironment)
    printResult(localSuccess({ environments }), json, formatEnvironmentList)
  },
  'environment show': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const environment = redactRuntimeEnvironment(
      resolveEnvironment(getDefaultUserDataPath(), selector)
    )
    printResult(localSuccess({ environment }), json, ({ environment: value }) =>
      formatEnvironment(value)
    )
  },
  'environment rm': async ({ flags, json }) => {
    const selector = getRequiredStringFlag(flags, 'environment')
    const removed = redactRuntimeEnvironment(removeEnvironment(getDefaultUserDataPath(), selector))
    printResult(
      localSuccess({ removed }),
      json,
      (result: EnvironmentRemoveResult) =>
        `Removed environment ${result.removed.name} (${result.removed.id}).`
    )
  },
  'environment config list': async ({ client, json }) => {
    const result = await client.call<PortableSettingsResult>('environment.config.getAll')
    printResult(result, json, ({ settings }) => formatPortableSettings(settings))
  },
  'environment config get': async ({ flags, client, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const result = await client.call<PortableSettingsResult>('environment.config.getAll')
    printResult(result, json, ({ settings }) =>
      key in settings ? `${key} = ${formatConfigValue(settings[key])}` : `${key} is not set`
    )
  },
  'environment config set': async ({ flags, client, json }) => {
    const key = getRequiredStringFlag(flags, 'key')
    const value = coerceConfigValue(getRequiredStringFlag(flags, 'value'))
    const result = await client.call<PortableSettingsResult>('environment.config.setMany', {
      [key]: value
    })
    printResult(result, json, ({ settings }) => `${key} = ${formatConfigValue(settings[key])}`)
  }
}

type PortableSettingsResult = { settings: Record<string, unknown> }

// Why: CLI values arrive as strings. JSON.parse coerces numbers/booleans/null so
// the server-side zod allow-schema receives the right runtime type; anything that
// is not valid JSON (e.g. an enum literal like `block`) is passed through as a
// string. The server allow-schema still has the final say on both key and type.
function coerceConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function formatConfigValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function formatPortableSettings(settings: Record<string, unknown>): string {
  const keys = Object.keys(settings).sort()
  if (keys.length === 0) {
    return 'No portable settings are set.'
  }
  return keys.map((key) => `${key} = ${formatConfigValue(settings[key])}`).join('\n')
}

function getRequiredStringFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${name}`)
  }
  return value
}

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return {
    id: 'local',
    ok: true,
    result,
    _meta: {
      runtimeId: 'local'
    }
  }
}
