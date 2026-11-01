/** Offline release-policy and smoke-secret regressions, with deliberately invalid cases. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { loadProbeCredentials } from '../smoke/credentials.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = { appId: '123456', appSecret: 'fictional-secret-only', userOpenid: 'OWNER_A' }

await test('manual validation has no OIDC authority; only protected upstream release tags can publish', () => {
  const wf = parse(readFileSync(join(root, '.github/workflows/publish.yml'), 'utf8'))
  assert.equal(wf.permissions['id-token'], undefined)
  assert.equal(wf.jobs.validate.permissions['id-token'], undefined)
  assert.equal(wf.jobs.publish.permissions['id-token'], 'write')
  assert.equal(wf.jobs.publish.environment, 'npm-release')
  assert.equal(wf.jobs.publish.needs, 'validate')
  const allowed = new Function('github', 'vars', 'startsWith', `return (${wf.jobs.publish.if})`)
  const base = { event_name: 'push', ref_type: 'tag', ref: 'refs/tags/v1.0.5', ref_protected: true, repository: 'xcisxc29/dsh-qq-plugin' }
  const run = (patch, vars = { NPM_PUBLISH_ENABLED: 'true' }) => Boolean(allowed({ ...base, ...patch }, vars, (s, p) => s.startsWith(p)))
  assert.equal(run({}), true)
  for (const patch of [{ event_name: 'workflow_dispatch' }, { ref_type: 'branch', ref: 'refs/heads/main' }, { ref_protected: false }, { repository: 'saranitim/dsh-qq-plugin' }, { ref: 'refs/tags/other' }]) assert.equal(run(patch), false)
  assert.equal(run({}, {}), false)
  assert.equal(wf.jobs.publish.steps.some((s) => s.uses?.startsWith('actions/checkout')), false)
  const publisher = wf.jobs.publish.steps.find((s) => s.run?.includes('npm publish')).run
  assert.match(publisher, /sha256sum --check --strict/)
  assert.match(publisher, /npm publish \.\/release\.tgz --ignore-scripts/)
  assert.match(publisher, /GITHUB_REF_NAME/)
  assert.equal(publisher.includes('npm ci'), false)
  // Run the real artifact verifier with a stub executable. No real publish is possible.
  const candidate = mkdtempSync(join(tmpdir(), 'qq-release-policy-'))
  try {
    mkdirSync(join(candidate, 'package')); mkdirSync(join(candidate, 'bin'))
    writeFileSync(join(candidate, 'package/package.json'), JSON.stringify({ name: 'dsh-qq-plugin', version: '1.0.5' }))
    writeFileSync(join(candidate, 'bin/npm'), '#!/bin/sh\nprintf stub > "$QQ_PUBLISH_MARKER"\n', { mode: 0o755 })
    execFileSync('tar', ['-czf', 'release.tgz', 'package/package.json'], { cwd: candidate })
    const digest = createHash('sha256').update(readFileSync(join(candidate, 'release.tgz'))).digest('hex')
    const marker = join(candidate, 'published-stub')
    const env = { ...process.env, PATH: `${join(candidate, 'bin')}:${process.env.PATH}`, QQ_PUBLISH_MARKER: marker, EXPECTED_DIGEST: digest, EXPECTED_VERSION: '1.0.5', GITHUB_REF_NAME: 'v1.0.5' }
    assert.equal(spawnSync('bash', ['-c', publisher], { cwd: candidate, env }).status, 0)
    assert.equal(readFileSync(marker, 'utf8'), 'stub')
    rmSync(marker)
    writeFileSync(join(candidate, 'release.tgz'), 'tampered artifact')
    assert.notEqual(spawnSync('bash', ['-c', publisher], { cwd: candidate, env }).status, 0)
    assert.equal(existsSync(marker), false)
  } finally { rmSync(candidate, { recursive: true, force: true }) }
  for (const job of Object.values(wf.jobs)) for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/)
  // Execute the actual tag check for both a matching and a mismatched version. No publishing.
  const check = wf.jobs.validate.steps.find((s) => s.name === 'Check version tag before packing').run
  for (const [tag, expected] of [['v1.0.5', 0], ['v9.9.9', 1]]) {
    const result = spawnSync('bash', ['-c', check], { cwd: root, env: { ...process.env, GITHUB_REF_NAME: tag } })
    assert.equal(result.status, expected)
  }
  for (const check of ['verify.mjs', 'verify-send-path.mjs', 'verify-client.mjs', 'verify-authorization.mjs', 'verify-security-config.mjs', 'verify-host-contract.mjs', 'check-doc-counts.mjs', 'check-unbound.mjs', 'check-unused-imports.mjs', 'npm pack --dry-run']) {
    assert.ok(JSON.stringify(wf.jobs.validate.steps).includes(check), `Release must retain ${check}`)
  }
})

await test('package manifest excludes fictional credentials even under allowed lib directory', () => {
  const dir = mkdtempSync(join(root, 'lib', 'pack-secret-test-'))
  try {
    for (const name of ['credentials.json', '.env', '.env.local', '.npmrc']) writeFileSync(join(dir, name), 'fictional-secret-only')
    const manifest = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
    assert.ok(manifest.files.some((x) => x.path === 'lib/authorization.js'))
    assert.equal(manifest.files.filter((x) => /credentials\.json$|(^|\/)\.env|(^|\/)\.npmrc|^smoke\//.test(x.path)).length, 0)
    assert.equal(execFileSync('git', ['ls-files', '--', 'smoke/credentials.json', '.env', '.npmrc'], { cwd: root, encoding: 'utf8' }), '')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

await test('Codex gate rejects skipped, stale, incomplete or failed scans', () => {
  const wf = parse(readFileSync(join(root, '.github/workflows/codex-security-pr.yml'), 'utf8'))
  assert.equal(wf.on.pull_request_target, undefined)
  assert.equal(wf.on.workflow_run, undefined)
  const scan = wf.jobs.security.steps.find((s) => s.id === 'scan')
  assert.equal(scan.with.scope, 'repository')
  assert.equal(scan.with.model, 'gpt-5.6-sol')
  assert.equal(scan.with['fail-on-severity'], 'medium')
  assert.ok(scan.with['max-cost'])
  const script = wf.jobs['security-gate'].steps[0].run
  const env = { ...process.env, SCAN_JOB_RESULT: 'success', SCAN_STATUS: 'completed', POLICY_STATUS: 'passed', SCANNED_SHA: 'abc123', EXPECTED_SHA: 'abc123' }
  assert.equal(spawnSync('bash', ['-c', script], { env }).status, 0)
  for (const patch of [{ SCAN_JOB_RESULT: 'skipped' }, { SCAN_STATUS: 'failed' }, { SCAN_STATUS: 'skipped' }, { POLICY_STATUS: 'failed' }, { SCANNED_SHA: '' }, { SCANNED_SHA: 'old123' }]) {
    assert.notEqual(spawnSync('bash', ['-c', script], { env: { ...env, ...patch } }).status, 0)
  }
})

await test('smoke secrets require explicit environment or an external file; both probes reject repository paths', () => {
  const external = mkdtempSync(join(tmpdir(), 'qq-secrets-outside-'))
  const internal = mkdtempSync(join(root, '.verify-secrets-'))
  const externalFile = join(external, 'credentials.json')
  const internalFile = join(internal, 'credentials.json')
  try {
    writeFileSync(externalFile, JSON.stringify(fixture), { mode: 0o600 })
    writeFileSync(internalFile, JSON.stringify(fixture), { mode: 0o600 })
    assert.throws(() => loadProbeCredentials({}), /QQ_SMOKE/)
    assert.throws(() => loadProbeCredentials({ QQ_SMOKE_APP_ID: fixture.appId }), /appSecret/)
    const env = { QQ_SMOKE_APP_ID: fixture.appId, QQ_SMOKE_APP_SECRET: fixture.appSecret, QQ_SMOKE_USER_OPENID: fixture.userOpenid }
    assert.deepEqual(loadProbeCredentials(env), fixture)
    assert.deepEqual(loadProbeCredentials({ QQ_SMOKE_CREDENTIALS_FILE: externalFile }), fixture)
    for (const path of [internalFile, relative(process.cwd(), internalFile)]) {
      assert.throws(() => loadProbeCredentials({ QQ_SMOKE_CREDENTIALS_FILE: path }), /仓库内/)
    }
    symlinkSync(internalFile, join(external, 'points-inside.json'))
    symlinkSync(externalFile, join(internal, 'points-outside.json'))
    for (const path of [join(external, 'points-inside.json'), join(internal, 'points-outside.json')]) {
      assert.throws(() => loadProbeCredentials({ QQ_SMOKE_CREDENTIALS_FILE: path }), /仓库内/)
    }
    // Actual scripts must fail before constructing a bot or attempting a live connection.
    for (const probe of ['step3-probe.mjs', 'step4-probe.mjs']) {
      const cleanEnv = { ...process.env, QQ_SMOKE_CREDENTIALS_FILE: internalFile }
      delete cleanEnv.QQ_SMOKE_APP_ID; delete cleanEnv.QQ_SMOKE_APP_SECRET; delete cleanEnv.QQ_SMOKE_USER_OPENID
      const result = spawnSync(process.execPath, [join(root, 'smoke', probe)], { env: cleanEnv, timeout: 2000, encoding: 'utf8' })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /仓库内/)
      assert.ok(!result.stderr.includes(fixture.appSecret))
    }
    assert.ok(execFileSync('git', ['check-ignore', 'smoke/credentials.json'], { cwd: root, encoding: 'utf8' }).includes('smoke/credentials.json'))
    // Repository root remains protected even in an exported copy without .git metadata.
    const exported = join(external, 'exported')
    mkdirSync(join(exported, 'smoke'), { recursive: true }); mkdirSync(join(exported, 'lib'))
    for (const path of ['smoke/credentials.mjs', 'lib/authorization.js']) writeFileSync(join(exported, path), readFileSync(join(root, path)))
    writeFileSync(join(exported, 'package.json'), '{"type":"module"}')
    writeFileSync(join(exported, 'credentials.json'), JSON.stringify(fixture))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { loadProbeCredentials } from './smoke/credentials.mjs'; loadProbeCredentials()`], {
      cwd: exported, env: { ...process.env, QQ_SMOKE_CREDENTIALS_FILE: join(exported, 'credentials.json') }, encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /仓库内/)
    // Malformed JSON must never echo a secret from the input.
    writeFileSync(externalFile, `{"appSecret":"${fixture.appSecret}`)
    assert.throws(() => loadProbeCredentials({ QQ_SMOKE_CREDENTIALS_FILE: externalFile }), (e) => !e.message.includes(fixture.appSecret) && /JSON/.test(e.message))
  } finally {
    rmSync(internal, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true })
  }
})
