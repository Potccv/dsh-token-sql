#!/usr/bin/env node
// Generate tsconfig.build.json that resolves DeepSeek Harness dependencies via
// TypeScript paths to the checkout's built declarations. No node_modules
// symlinks are created inside this project.

import { execSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function hasPackages(dir) {
  return dir !== '' && existsSync(join(dir, 'packages'))
}

async function detectCheckout() {
  const env = process.env.DSH_CHECKOUT
  if (env && hasPackages(env)) return env

  const parent = resolve(ROOT, '../..')
  if (hasPackages(parent)) return parent

  const home = process.env.HOME || ''
  const bases = [home, join(home, 'code'), join(home, 'projects'), join(home, 'dev'), join(home, 'src'), '/opt', '/srv', '/workspace']
  const names = ['dsh', 'deepseek-harness', 'deepseekharness', 'DeepSeek-Harness', 'DeepSeekHarness', 'deepseek_harness']
  for (const base of bases) {
    if (!base) continue
    for (const name of names) {
      const candidate = join(base, name)
      if (hasPackages(candidate)) return candidate
    }
  }

  if (home) {
    try {
      const found = execSync(
        `find "${home}" -maxdepth 4 -type d \\( -name 'deepseek-harness' -o -name 'deepseekharness' -o -name 'DeepSeek-Harness' -o -name 'DeepSeekHarness' -o -name 'dsh' \\) -exec test -d '{}/packages' \\; -print -quit`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      if (found) return found
    } catch {
      // fall through to prompt
    }
  }

  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question('未自动探测到 DeepSeek Harness checkout，请输入其路径: ')
    rl.close()
    return answer.trim()
  }

  throw new Error('未自动探测到 DSH checkout，且当前为非交互环境；请通过 DSH_CHECKOUT 环境变量指定')
}

const CHECKOUT = await detectCheckout()
if (!hasPackages(CHECKOUT)) {
  throw new Error(`无效的 DSH checkout 路径（缺少 packages/ 目录）: ${CHECKOUT}`)
}

const P = (p) => resolve(CHECKOUT, p)
const typeRoots = [
  P('node_modules/@types'),
  P('node_modules/.pnpm/@types+react@18.3.31/node_modules/@types'),
  P('node_modules/.pnpm/@types+react-dom@18.3.7_@types+react@18.3.31/node_modules/@types'),
].filter(existsSync)

const paths = {
  react: [P('node_modules/.pnpm/@types+react@18.3.31/node_modules/@types/react/index.d.ts')],
  'react/jsx-runtime': [P('node_modules/.pnpm/@types+react@18.3.31/node_modules/@types/react/jsx-runtime.d.ts')],
  '@deepseek-ai/cordis': [P('vendor/cordis/lib/types/index.d.ts')],
  '@deepseek-ai/schemastery': [P('vendor/schemastery/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-session': [P('packages/core/session/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-llm': [P('packages/llm/llm/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-scope': [P('packages/core/scope/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-typert-protocol': [P('packages/typert/protocol/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-brand': [P('packages/util/brand/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-attachment': [P('packages/attachment/attachment/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-settings': [P('packages/settings/settings/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-host-webserver': [P('packages/host/webserver/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-session-persistence': [P('packages/session/session-persistence/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-session-title': [P('packages/session/session-title/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-compaction/types': [P('packages/compaction/compaction/lib/types/types.d.ts')],
  '@deepseek-ai/dsh-web-search-deepseek': [P('packages/web/web-search-deepseek/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-client-runtime/client': [P('packages/client/runtime/lib/types/client/index.d.ts')],
  '@deepseek-ai/dsh-client-ui-settings-plugins/client': [P('packages/client/ui-settings-plugins/lib/types/client/index.d.ts')],
  '@deepseek-ai/dsh-client-ui-slots': [P('packages/client/ui-slots/lib/types/index.d.ts')],
  '@deepseek-ai/dsh-client-ui-primitives': [P('packages/client/ui-primitives/lib/types/index.d.ts')],
}

const config = {
  extends: './tsconfig.json',
  compilerOptions: {
    ...(typeRoots.length > 0 ? { typeRoots } : {}),
    paths,
  },
}

writeFileSync(
  join(ROOT, 'tsconfig.build.json'),
  JSON.stringify(config, null, 2) + '\n',
)

console.log(`Generated tsconfig.build.json (checkout: ${CHECKOUT})`)
