# Security remediation — DSH 0.2.1-rc.5

This change addresses the three findings from [the original Codex Security scan](https://chatgpt.com/codex/cloud/security/runs/wfr_6ed8b48cecc25bf00ad764e159b26c104c955ace85a896fe45427ed2e70d4d42). Baseline: `29cc25d1df556d7ae223c3f09a325140db6bd638`. Scope: `saranitim/dsh-qq-plugin`; target host: an existing DeepSeek Harness **0.2.1-rc.5** installation. Work was performed in the current Work session, without delegated coding tasks or subagents.

**Code remediation and local validation are prepared. An independent Codex Security review of the repaired PR head is still required.** The historical scan covers the baseline, not this change. Native PR security review currently reports `securityReviewEnabled=false` and `securityReviewRolloutEnabled=false`. The Cloud launch interface exposed to this session does not select a PR head; rescanning unchanged main would not validate these fixes.

## Finding disposition

| Original finding | Change and verification | Remaining boundary |
| --- | --- | --- |
| `csf_fe54f11f4d1652d8a3e3df19` — High | Split validation from publication. Manual runs never publish and have no OIDC authority. Publishing requires a protected version tag push in the upstream package repository, an explicit enable variable, and `npm-release`. The publisher consumes one exact artifact, checks its SHA-256 and package identity/version, and disables lifecycle scripts. All original CI and tarball-presence checks remain. Tests exercise event/ref/repository policy, tag mismatch, and tampered artifact rejection with a stub publisher. | Actual exploitability depended on external npm Trusted Publisher authority. This fork has not been shown to possess upstream npm authority. External protected environment/tag/npm binding is not configured or verified by this PR; publication remains disabled here. |
| `csf_7e495e73ecebef7c0c5d92e5` — High | Exact case-sensitive owner authorization precedes deduplication, attachment download, pending-message delivery, interaction answers and session routing. Missing owner or mismatched app identity refuses connection. QR and manual enrollment require owner identity. New binding revokes old bot callbacks, in-flight attachment dispatch, pending interactions and old destinations. Legacy foreign bindings are excluded from notifications. Cancelled QR callbacks cannot enroll stale owners. UI and both READMEs explain migration. | Tencent must deliver another sender's event for the old vulnerability to be reachable. No claim is made that every default Tencent bot was externally reachable. Desktop/profile access is still trusted. |
| `csf_1ded710aaf194b19a7114a5b` — Medium | Both probes use one explicit environment/external-file loader. Repository, relative and symlink paths are rejected using canonical paths and Git root discovery, including nested working trees. Git ignores credentials and local environment files; npm uses explicit source/doc/image extension allowlists as well as ignore rules. A regression demonstrated that the former directory allowlist could otherwise override root ignore rules for nested secrets. Tests execute both real probe entry points only with rejected fictional input, check Git ignore behavior, and inspect npm's manifest with fictional secret files under an otherwise packaged directory. | No real leaked key was found or used in this task. Deliberate force-adding secrets is outside ignore-rule protection. Live probes remain opt-in. |

## Validation

Runtime: Node.js 24.22.1 on Linux. The actual commands are suitable for reproducing the checks; see the PR/Actions records for its exact commit and remote status.

- Original baseline: 822 host assertions, 108 client checks, 60 send-path assertions passed before editing.
- Repaired tree: the same three suites, syntax checks, documentation-count checker (including its reverse controls), unbound-name checker and unused-import checker are retained.
- `node scripts/verify-authorization.mjs`: owner, sender/account mismatches, dedup poisoning, denied downloads, legitimate prompts/commands/attachments/approvals, account/owner rotation, delayed callbacks, legacy destinations, manual/QR enrollment, cancelled QR callbacks.
- Negative control: seven selected authorization regression groups were executed against the original frozen source; **all seven failed**. The tests detect the old behavior rather than only agreeing with the new implementation.
- `node scripts/verify-security-config.mjs`: publishing authority, exact artifact/tag checks, strict Security gate, secret-source/path checks and npm packaging exclusions. The publisher is a local stub; no real npm publishing occurs.
- `scripts/verify-host-contract.mjs`: uses the **real** published `@deepseek-ai/dsh-credentials-local@0.2.1-rc.5` and Cordis service in a temporary home. Save, describe, reload from disk, owner rotation, reject incomplete identity, delete and owner-only POSIX file permissions are checked. CI installs this exact host component outside the plugin dependency tree.
- `actionlint` 1.7.12: workflow syntax/expression validation. Its downloaded release checksum was verified.
- `npm pack --dry-run`: original required entry points/docs/tools remain, including the new authorization module. No real credentials are used.

The official host release is [dsh-v0.2.1-rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5), commit `b830ec950faba0a46dda564be3e2d854afed94f1`. Its [credential record interface](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/credentials/credentials/src/types.ts), [file provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/credentials/credentials-local/src/index.ts) and [session-controller request types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/packages/api/session-controller/src/types.ts) were inspected. Plugin grants continue to contain only the host-supported `kind` and JSON `payload` fields.

**Limits:** this was not a live desktop/UI end-to-end run. A complete real DSH desktop profile and QQ transport were not started. No real QQ account sent messages, no real model received prompts, and no package was published. Session and transport regressions use fakes; the credential contract uses the real rc.5 host component. `check-cross-plugin.mjs` requires the user's real profile and remains unexecuted here. Passing these tests does not equal an independent Security scan.

## Enable the independent review

The prepared `.github/workflows/codex-security-pr.yml` scans the exact PR head with repository scope, model `gpt-5.6-sol`, effort `xhigh`, and a Medium severity gate. The effort is the handoff's chosen configuration, not a claim about the historical scan effort. Model access must be verified without silently changing models.

1. In [Actions secrets](https://github.com/saranitim/dsh-qq-plugin/settings/secrets/actions), set `CODEX_SECURITY_API_KEY` through GitHub's secure form, using an approved API project. Do not send the key in chat.
2. In [Actions variables](https://github.com/saranitim/dsh-qq-plugin/settings/variables/actions), set `CODEX_SECURITY_MAX_COST` to the user's approved positive USD estimate threshold. This is not a hard billing cap; in-flight requests may exceed it. No budget is assumed in this PR.
3. Rerun the failed Security workflow for the **current PR head** after setup. Do not interpret the missing-credential/budget failure or a skipped scan as passing.
4. Read the complete findings and coverage artifacts. Deferred/incomplete coverage and budget stops require assessment even when the reported severity policy passes.
5. In [repository rules](https://github.com/saranitim/dsh-qq-plugin/settings/rules), require the existing CI job and `Codex Security gate` before merging. At the initial read, main was unprotected and the ruleset list was empty. Creating the YAML alone does not configure this.

The current connector has no supported Secrets/ruleset/environment mutation endpoint. The admin flag returned by repository metadata does not make those APIs available. External settings remain explicit user actions; the key is never requested in chat. The separate upstream npm publishing policy should remain disabled unless the package administrator deliberately configures the protected environment and matching Trusted Publisher. This task does not authorize publication or merge.

## Review loop and stopping rules

Persisted state is `.github/security-remediation.json`; remediation commits carry `Security-Remediation-Round` and `Security-Source-Run` trailers. Limit actual fix rounds to five. Use the same PR/branch throughout. Configuration failures do not consume fix rounds and must not provoke random code changes or empty commits.

The follow-up task is scoped to the actual repair PR after creation. Polling, when enabled, is hourly; robot comments are not assumed to be a reliable wake-up event. Until scan access and an explicit budget are ready, keep the follow-up paused. On each run:

1. Read PR status and current head; stop and disable the task if closed, merged or paused by the user.
2. Find the completed review for exactly that head. Running reviews are awaited without starting duplicates.
3. Read complete findings and coverage. Resolve valid findings with focused regressions in this Work session; no coding subagents or external Codex repair tasks.
4. Preserve the original finding dispositions, append processed report IDs, increment the fix-round trailer/state only for actual remediation, and update the same PR.
5. Stop and report when all original valid findings have specific evidence, current-head independent review is complete, unresolved Medium/High/Critical findings are zero, required CI passes, and coverage is acceptable. Pause on credentials/quota/budget/policy blockers, five rounds, or repeated nonconvergence.
6. Never merge, publish npm, close original Cloud findings without verified evidence, or send real QQ messages.

The final PR description records the actual task ID/status and any still-missing configuration. This document is a reproducible implementation record, not a claim that the paused loop or independent scan has already succeeded.
