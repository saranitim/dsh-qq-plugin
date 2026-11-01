/** Real DSH v0.2.1-rc.5 credential service, isolated home and fictional secrets. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CredentialStore } from '../lib/credentials.js'

assert.ok(process.env.DSH_COMPAT_NODE_MODULES, 'Set DSH_COMPAT_NODE_MODULES to the isolated installation')
const require = createRequire(join(resolve(process.env.DSH_COMPAT_NODE_MODULES), '..', 'package.json'))
const pkg = require('@deepseek-ai/dsh-credentials-local/package.json')
assert.equal(pkg.version, '0.2.1-rc.5')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { LocalCredentialProvider, parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')))
const dir = mkdtempSync(join(tmpdir(), 'qq-dsh-contract-'))
const path = join(dir, '.credentials.yaml')
const fibers = []
async function boot() {
  const ctx = new Context()
  const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
  fibers.push(fiber)
  await fiber
  return new CredentialStore(ctx)
}
try {
  const first = await boot()
  const fixture = { appId: '123456', appSecret: 'fictional-test-secret', userOpenid: 'OWNER_A' }
  assert.equal(first.available, true)
  await first.save(fixture)
  assert.equal((await first.load(fixture.appId)).userOpenid, 'OWNER_A')
  assert.equal((await first.describe(fixture.appId)).configured, true)
  assert.equal(parseCredentialsDocument(readFileSync(path, 'utf8'), path).records.size, 1)
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0)
  const reloaded = await boot()
  assert.equal((await reloaded.load(fixture.appId)).appSecret, fixture.appSecret)
  await reloaded.save({ ...fixture, userOpenid: 'OWNER_B' })
  assert.equal((await reloaded.load(fixture.appId)).userOpenid, 'OWNER_B')
  await assert.rejects(reloaded.save({ ...fixture, userOpenid: undefined }), /userOpenid/)
  assert.equal((await reloaded.load(fixture.appId)).userOpenid, 'OWNER_B')
  await reloaded.remove(fixture.appId)
  assert.equal(await reloaded.load(fixture.appId), undefined)
  console.log('PASS: DSH 0.2.1-rc.5 actual credential save, reload, owner rotation, reject incomplete identity, delete, file permissions')
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
}
