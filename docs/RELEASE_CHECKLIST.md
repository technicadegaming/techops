# Release & Deploy Checklist

Use this checklist for safe, repeatable releases.

## 1) Pre-merge checklist (PR readiness)

- [ ] Scope is minimal, intentional, and rollback-friendly.
- [ ] No destructive schema/data migrations are introduced.
- [ ] Multi-tenant boundaries are preserved (`companyId`, `companies/{companyId}/...`).
- [ ] Docs are updated for any command/workflow changes.
- [ ] CI is green for the enforced suites (lint, functions tests, rules tests) and the PR notes any additional conditional local checks that applied.
- [ ] Reviewer can tell which implementation docs were used (`docs/DATA_MODEL.md`, `docs/FRONTEND_STRUCTURE.md`, `docs/DEPLOYMENT.md`, `docs/SECURITY.md`, `docs/APP_SHELL_REMAINING_SEAMS.md`) based on the area touched.
- [ ] PR description/template states whether `npm run test:app-shell` and `npm run test:rules` were applicable.

Recommended local verification:

```bash
npm run lint
npm run test --prefix functions
```

Add these when relevant:

```bash
npm run test:app-shell
npm run test:rules
```

- `npm run test:app-shell` is expected for `src/app.js`, `src/app/*`, and shell/controller seam changes.
- `npm run test:rules` is expected for rules changes and security-sensitive tenant/storage boundary changes; it depends on working local Firestore + Storage emulators via the Firebase CLI.

## 2) Pre-deploy checklist (release gate)

- [ ] Target Firebase project/environment is confirmed.
- [ ] Local branch is up to date with reviewed main branch state.
- [ ] Required secrets/configuration are present and validated.
- [ ] Any rules/index/function changes are included in deploy plan.
- [ ] Operator has rollback references (last known-good commit/deploy).
- [ ] If the release includes app-shell work, the team has confirmed it stayed within the stabilization guidance in `docs/APP_SHELL_REMAINING_SEAMS.md` rather than reopening broad shell extraction work mid-release.

Recommended deploy order:

```bash
firebase deploy --only firestore:rules
firebase deploy --only storage
firebase deploy --only firestore:indexes
firebase deploy --only functions
firebase deploy --only hosting
```

## 3) Post-deploy smoke test checklist

- [ ] App loads and key routes render in hosting.
- [ ] Auth login flow works for expected roles.
- [ ] Firestore access remains tenant-scoped (`companyId`).
- [ ] Storage access remains tenant-scoped (`companies/{companyId}/...`).
- [ ] Key function-backed workflows execute successfully.
- [ ] No critical errors in Firebase console logs.

## 4) Rollback / recovery notes

- If security or tenancy is impacted, immediately roll back rules to the last known-good commit.
- Roll back functions if runtime/auth/policy behavior regresses.
- Re-deploy prior hosting version if UI behavior regresses.
- Document incident timeline and follow-up action items in the next PR.

## Branch protection recommendations for `main`

Keep this lightweight and practical:

1. Require pull requests before merge.
2. Require status checks to pass:
   - CI lint
   - CI functions tests
   - CI rules tests
3. Treat app-shell coverage as a documented PR/reviewer expectation when `src/app.js`, `src/app/*`, or shell/controller seams change, rather than forcing it as a blanket branch-protection check.
4. Require branch to be up to date before merge.
5. Restrict direct pushes to `main`.
6. Optionally require at least one approving review.

## CI cache hygiene note

CI already caches npm dependencies via `actions/setup-node` using lockfiles and now also caches Firebase emulator binaries in `~/.cache/firebase/emulators`. If `npm run test:rules` fails in CI because the Firebase CLI cannot fetch emulator artifacts, treat that as an environment/download problem rather than a silent pass: the rules suite still requires working Firestore + Storage emulators to execute.

For local troubleshooting, re-run after transient network issues clear, or warm the emulator cache ahead of time with `firebase setup:emulators:firestore` and `firebase setup:emulators:storage`.
