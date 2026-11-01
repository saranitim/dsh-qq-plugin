/** Exercise the real runtime via its SDK event boundary; no QQ or model requests. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const root = new URL('../', import.meta.url)
const data = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const sdk = data(`
  import { EventEmitter } from 'node:events'
  export const instances = []
  export class QQBot extends EventEmitter {
    constructor(options) { super(); this.options = options; this.sent = []; instances.push(this) }
    async start() {}
    stop() { this.stopped = true }
    async sendText(target, text) { this.sent.push({ target, text }); return { ok: true } }
    async sendTyping() {}
  }
`)
const connector = data(`
  export let callbacks
  export function startQrConnect(value) { callbacks = value; return () => {} }
`)
const mediaUrl = new URL('lib/media.js', root).href
const media = data(`
  export { describeMedia, describeMissing, mediaDir } from ${JSON.stringify(mediaUrl + '?real')}
  export const downloads = []
  export let waitForDownload
  export function hold(promise) { waitForDownload = promise }
  export async function downloadAttachment(args) {
    downloads.push(args)
    if (waitForDownload) await waitForDownload
    return { path: '/fictional/image.png', bytes: 1, kind: 'image' }
  }
`)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@tencent-connect/qqbot-nodejs') return { url: sdk, shortCircuit: true }
    if (specifier === '@tencent-connect/qqbot-connector') return { url: connector, shortCircuit: true }
    if (specifier === './media.js' && context.parentURL === new URL('lib/runtime.js', root).href) return { url: media, shortCircuit: true }
    return next(specifier, context)
  },
})
const { instances } = await import(sdk)
const mediaProbe = await import(media)
const { QqRuntime } = await import('../lib/runtime.js')
const { CredentialStore, accountRecordKey } = await import('../lib/credentials.js')
const { QqBindSession } = await import('../lib/login.js')
const { registerRoutes } = await import('../lib/routes.js')
const { configureLog } = await import('../lib/log.js')
const APP = '123456'
const OWNER = 'OWNER_A'
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, 'Expected event did not arrive')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const message = (over = {}) => ({ kind: 'c2c', senderId: OWNER, messageId: 'id-1', content: 'hello', attachments: [], ...over })

async function setup(t, { owner = OWNER, credentialApp = APP, bindings = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qq-authorization-'))
  configureLog(dir)
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ version: 1, accounts: { [APP]: { appId: APP, userOpenid: owner, enabled: true } }, bindings }))
  const payloads = new Map([[APP, { appId: credentialApp, appSecret: 'fictional-secret', userOpenid: owner }]])
  const created = [], prompts = []
  const ctx = {
    get: () => undefined,
    sessionController: {
      async create(value) { created.push(value); return { sessionId: value.sessionId } },
      async rename() {},
      async prompt(value) { prompts.push(value); return {} },
      async cancel() {},
    },
  }
  const credentials = {
    available: true,
    load: async (id) => payloads.get(id),
    save: async (value) => { payloads.set(value.appId, { ...value }); return { ...value } },
    remove: async (id) => payloads.delete(id),
    describe: async () => ({ configured: true }),
  }
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  const runtime = new QqRuntime(ctx, { home: dir, workspace, stateFile, credentials })
  t.after(async () => { await runtime.halt(); rmSync(dir, { recursive: true, force: true }) })
  await runtime.start(APP)
  const bot = runtime.connected ? instances.at(-1) : undefined
  const inbound = async (value, context = {}) => bot.listeners('message')[0](context, value)
  return { dir, stateFile, runtime, bot, inbound, created, prompts, payloads }
}

await test('unbound / malformed owner and wrong credential account fail closed', async (t) => {
  for (const config of [{ owner: '' }, { owner: ' ' }, { owner: 'OWNER_A ' }, { credentialApp: '654321' }]) {
    const f = await setup(t, config)
    assert.equal(f.runtime.connected, false)
    assert.equal(f.created.length, 0)
  }
})

await test('foreign senders cannot route, poison dedup, download, queue or create sessions', async (t) => {
  const f = await setup(t)
  const before = readFileSync(f.stateFile, 'utf8')
  const count = mediaProbe.downloads.length
  for (const senderId of ['STRANGER', '', 'owner_a', 'OWNER_A ', undefined, 123]) {
    for (const content of ['hello', '/list all', '/switch 1', '允许']) {
      await f.inbound(message({ senderId, content, attachments: [{ url: 'https://invalid.test/a.png' }] }))
    }
  }
  assert.equal(readFileSync(f.stateFile, 'utf8'), before)
  assert.equal(f.created.length, 0)
  assert.equal(f.prompts.length, 0)
  assert.equal(f.bot.sent.length, 0)
  assert.equal(mediaProbe.downloads.length, count)
  // Same message ID must still work for the owner: unauthorized traffic cannot consume it.
  await f.inbound(message())
  assert.equal(f.created.length, 1)
  assert.equal(f.prompts.length, 1)
  await f.inbound(message())
  assert.equal(f.prompts.length, 1)
})

await test('wrong event/context account is rejected before state changes; exact owner commands work', async (t) => {
  const f = await setup(t)
  await f.inbound(message({ accountId: '654321', content: '/help' }))
  await f.inbound(message({ content: '/help' }), { accountId: '654321' })
  assert.equal(f.bot.sent.length, 0)
  await f.inbound(message({ accountId: APP, content: '/help' }), { accountId: APP })
  assert.equal(f.bot.sent.length, 1)
})

await test('owner attachments remain available; attachment from stranger is not fetched', async (t) => {
  const f = await setup(t)
  f.runtime.applySettings({ autoReplyAttachments: false })
  const count = mediaProbe.downloads.length
  await f.inbound(message({ attachments: [{ url: 'https://invalid.test/a.png' }], content: '' }))
  assert.equal(mediaProbe.downloads.length, count + 1)
  await f.inbound(message({ messageId: 'id-2', content: 'describe image' }))
  assert.equal(f.prompts.length, 1)
  assert.ok(JSON.stringify(f.prompts).includes('/fictional/image.png'))
})

await test('identity rotation revokes old bot, owner, interactions and in-flight attachments', async (t) => {
  const f = await setup(t)
  f.runtime.applySettings({ autoReplyAttachments: false })
  const deferred = Promise.withResolvers()
  const count = mediaProbe.downloads.length
  mediaProbe.hold(deferred.promise)
  const pending = f.inbound(message({ attachments: [{ url: 'https://invalid.test/a.png' }] }))
  await until(() => mediaProbe.downloads.length === count + 1)
  await f.runtime.rememberCredentials({ appId: APP, appSecret: 'rotated-fictional-secret', userOpenid: 'OWNER_B' })
  deferred.resolve()
  await pending
  mediaProbe.hold(undefined)
  assert.equal(f.bot.stopped, true)
  await f.inbound(message({ messageId: 'old-callback' }))
  const bot = instances.at(-1)
  const inbound = bot.listeners('message')[0]
  await inbound({}, message({ messageId: 'old-owner' }))
  assert.equal(f.prompts.length, 0)
  await inbound({}, message({ senderId: 'OWNER_B', messageId: 'new-owner' }))
  assert.equal(f.prompts.length, 1)
  assert.ok(!JSON.stringify(f.prompts).includes('/fictional/image.png'))
  await f.runtime.push(`${APP}:${OWNER}`, 'must not leak')
  assert.equal(bot.sent.some((s) => s.target.targetId === OWNER), false)
})

await test('switching bot accounts rejects delayed callbacks even for the same OpenID', async (t) => {
  const f = await setup(t)
  await f.runtime.rememberCredentials({ appId: '654321', appSecret: 'fictional-secret', userOpenid: OWNER })
  await f.inbound(message())
  assert.equal(f.prompts.length, 0)
  await instances.at(-1).listeners('message')[0]({}, message({ accountId: '654321' }))
  assert.equal(f.prompts.length, 1)
  assert.ok(Object.keys(JSON.parse(readFileSync(f.stateFile)).bindings).every((key) => key.startsWith('654321:')))
})

await test('legacy stranger binding cannot receive notifications, even when it was used most recently', async (t) => {
  const binding = (peer, at) => ({ conversationId: `${APP}:${peer}`, accountId: APP, peerId: peer, sessionId: `session-${peer}`, lastUsedAt: at })
  const f = await setup(t, { bindings: { [`${APP}:STRANGER`]: binding('STRANGER', 100), [`${APP}:${OWNER}`]: binding(OWNER, 1) } })
  await f.runtime.notifyFromTool({ text: 'owner notification' }, {})
  assert.equal(f.bot.sent.at(-1).target.targetId, OWNER)
  await f.runtime.push(`${APP}:STRANGER`, 'must not leak')
  assert.equal(f.bot.sent.length, 1)
})

await test('only the owner can answer an approval; halt releases outstanding interactions', async (t) => {
  const key = `${APP}:${OWNER}`
  const f = await setup(t, { bindings: { [key]: { conversationId: key, accountId: APP, peerId: OWNER, sessionId: 'session-approval' } } })
  let resolved = false
  const approval = f.runtime.approvalListener()({ agent: { session: { id: 'session-approval' } }, toolName: 'test-tool' }, async () => 'delegated').then((x) => { resolved = true; return x })
  await until(async () => (await f.runtime.status()).pendingInteractions === 1)
  assert.equal((await f.runtime.status()).pendingInteractions, 1)
  await f.inbound(message({ senderId: 'STRANGER', content: '允许' }))
  assert.equal(resolved, false)
  await f.inbound(message({ content: '允许' }))
  assert.notEqual(await approval, 'delegated')
  const second = f.runtime.approvalListener()({ agent: { session: { id: 'session-approval' } } }, async () => 'delegated')
  await until(async () => (await f.runtime.status()).pendingInteractions === 1)
  await f.runtime.halt()
  assert.equal(await second, 'delegated')
})

await test('credential store rejects incomplete owner and mismatched record identity without writes', async () => {
  const records = new Map()
  let writes = 0
  const store = new CredentialStore({ get: () => ({
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, fn) => { writes++; records.set(key, await fn()) },
  }) })
  await assert.rejects(store.save({ appId: APP, appSecret: 'fictional-secret' }), /userOpenid/)
  assert.equal(writes, 0)
  await store.save({ appId: APP, appSecret: 'fictional-secret', userOpenid: OWNER })
  assert.equal((await store.load(APP)).userOpenid, OWNER)
  records.get(accountRecordKey(APP)).payload.appId = '654321'
  assert.equal(await store.load(APP), undefined)
})

await test('manual route requires owner before calling runtime and preserves exact valid identity', async () => {
  let handler, called = 0
  registerRoutes({ get: () => ({ register: (route) => { handler = route.handler; return () => {} } }) }, {
    rememberCredentials: async (value) => { called++; return value },
  })
  const post = (body) => new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.url = '/.dsh-qq-plugin/credentials'
    handler(req, { writeHead() {}, end: (text) => resolve(JSON.parse(text)) })
  })
  assert.equal((await post({ appId: APP, appSecret: 'fictional-secret' })).ok, false)
  assert.equal(called, 0)
  assert.equal((await post({ appId: APP, appSecret: 'fictional-secret', userOpenid: OWNER })).userOpenid, OWNER)
  assert.equal(called, 1)
})

await test('QR enrollment does not report success without an owner', async () => {
  let saved = 0
  const bind = new QqBindSession({ onConfirmed: async () => { saved++ } })
  await bind.start()
  const qr = await import(connector)
  qr.callbacks.onSuccess([{ appId: APP, appSecret: 'fictional-secret' }])
  await tick()
  assert.equal(bind.snapshot().phase, 'failed')
  assert.equal(saved, 0)
  bind.cancel()
})

await test('QR callbacks from a cancelled/replaced binding cannot enroll an old identity', async () => {
  const saved = []
  const bind = new QqBindSession({ onConfirmed: async (value) => { saved.push(value) } })
  const qr = await import(connector)
  await bind.start()
  const old = qr.callbacks
  await bind.start()
  old.onSuccess([{ appId: APP, appSecret: 'fictional-secret', userOpenid: 'OLD_OWNER' }])
  await tick()
  assert.equal(saved.length, 0)
  qr.callbacks.onSuccess([{ appId: APP, appSecret: 'fictional-secret', userOpenid: OWNER }])
  await tick()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].userOpenid, OWNER)
  assert.equal(bind.snapshot().phase, 'succeeded')
  bind.cancel()
})
