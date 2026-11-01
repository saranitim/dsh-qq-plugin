/** Live probes only: no implicit secret files and no repository-local credentials. */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateCredentials } from '../lib/authorization.js'

const packageRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
function within(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function gitRoot(dir) {
  try {
    return realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim())
  } catch { return undefined }
}

export function loadProbeCredentials(env = process.env) {
  let value
  if (env.QQ_SMOKE_APP_ID !== undefined || env.QQ_SMOKE_APP_SECRET !== undefined || env.QQ_SMOKE_USER_OPENID !== undefined) {
    value = { appId: env.QQ_SMOKE_APP_ID, appSecret: env.QQ_SMOKE_APP_SECRET, userOpenid: env.QQ_SMOKE_USER_OPENID }
  } else if (env.QQ_SMOKE_CREDENTIALS_FILE) {
    const requested = resolve(env.QQ_SMOKE_CREDENTIALS_FILE)
    const resolved = realpathSync(requested)
    const roots = [packageRoot, gitRoot(packageRoot), gitRoot(process.cwd()), gitRoot(dirname(requested)), gitRoot(dirname(resolved))].filter(Boolean)
    if (roots.some((root) => within(root, requested) || within(root, resolved))) {
      throw new Error('拒绝读取仓库内的凭据（包括符号链接）；请使用环境变量或仓库外文件')
    }
    if (!statSync(resolved).isFile()) throw new Error('凭据路径必须是仓库外的普通文件')
    // Do not include JSON parser diagnostics: they can quote secret input.
    try { value = JSON.parse(readFileSync(resolved, 'utf8')) }
    catch { throw new Error('仓库外凭据文件不是有效 JSON') }
  } else {
    throw new Error('请提供 QQ_SMOKE_APP_ID、QQ_SMOKE_APP_SECRET、QQ_SMOKE_USER_OPENID，或 QQ_SMOKE_CREDENTIALS_FILE 指向仓库外凭据；不要在仓库内创建 credentials.json')
  }
  if (value === null || typeof value !== 'object') throw new Error('凭据必须是对象')
  validateCredentials(value)
  return { appId: value.appId, appSecret: value.appSecret, userOpenid: value.userOpenid }
}
