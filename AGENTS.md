# AGENTS.md

## Purpose
This repository is a Firebase-based, multi-tenant operations platform evolving into **Scoot Business**. Keep changes incremental, reviewable, and low risk.

## Ground rules
- Preserve the current Firebase architecture (Auth + Firestore + Functions + Storage + Hosting).
- Do **not** migrate frameworks or rewrite the app.
- Do **not** introduce destructive schema/data migrations.
- Prefer small PRs with clear scope and rollback paths.
- Keep user-facing branding aligned to Scoot Business where safe.

## Runbook commands
- Install root deps: `npm install`
- Install functions deps: `npm install --prefix functions`
- Lint: `npm run lint`
- Functions tests: `npm run test --prefix functions`
- Deploy hosting: `firebase deploy --only hosting`
- Deploy functions: `firebase deploy --only functions`
- Deploy rules: `firebase deploy --only firestore:rules,storage`

## Security and tenancy constraints
- Respect company scoping boundaries in Firestore (`companyId`) and Storage paths (`companies/{companyId}/...`).
- Rules changes must include/maintain tests where feasible.
- Never commit local secret material (for example `functions/.secret.local`).

## “Done” criteria for Codex changes
A change is done only when all are true:
1. Scope is minimal and behavior changes are intentional.
2. Docs are updated when commands/architecture/workflows changed.
3. `npm run lint` passes.
4. `npm run test --prefix functions` passes.
5. PR description includes risk notes + any manual follow-up.
