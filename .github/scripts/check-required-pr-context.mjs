import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyRequiredPrContext(parseYaml) {
  const directory = '.github/workflows'
  const providers = readdirSync(directory)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => {
      const workflow = parseYaml(readFileSync(join(directory, file), 'utf8'))
      return Object.entries(workflow.jobs)
        .filter(([id, job]) => (job.name ?? id) === 'PR checks passed')
        .map(([id]) => `${file}:${id}`)
    })
  if (providers.length !== 1 || providers[0] !== 'pr.yml:verify') {
    throw new Error(`Required PR context must belong only to pr.yml:verify; found ${providers}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const yaml = globalThis.Bun?.YAML
  if (!yaml) {
    throw new Error('Run workflow context validation with the pinned Bun runtime.')
  }
  verifyRequiredPrContext(yaml.parse)
  console.log('Required PR check context verified.')
}
