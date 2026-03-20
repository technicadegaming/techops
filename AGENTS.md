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
- App-shell tests: `npm run test:app-shell`
- Rules tests: `npm run test:rules`
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
5. `npm run test:app-shell` passes when shell modules, shell controllers, or `src/app.js`/`src/features/*` seams are touched.
6. `npm run test:rules` passes when Firestore rules, Storage rules, tenant boundaries, or other security-sensitive access paths are touched, and the required Firebase emulators are available.
7. PR description includes risk notes + any manual follow-up.

For contributor/reviewer reading order, use `README.md` as the start path, then jump to `docs/DATA_MODEL.md`, `docs/FRONTEND_STRUCTURE.md`, `docs/DEPLOYMENT.md`, `docs/RELEASE_CHECKLIST.md`, `docs/SECURITY.md`, and `docs/APP_SHELL_REMAINING_SEAMS.md` based on the area being changed.
