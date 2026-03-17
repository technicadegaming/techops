# Release & Deploy Checklist

Use this checklist for safe, repeatable releases.

## 1) Pre-merge checklist (PR readiness)

- [ ] Scope is minimal, intentional, and rollback-friendly.
- [ ] No destructive schema/data migrations are introduced.
- [ ] Multi-tenant boundaries are preserved (`companyId`, `companies/{companyId}/...`).
- [ ] Docs are updated for any command/workflow changes.
- [ ] CI is green for lint, functions tests, and rules tests.

Recommended local verification:

```bash
npm run lint
npm run test --prefix functions
npm run test:rules
```

## 2) Pre-deploy checklist (release gate)

- [ ] Target Firebase project/environment is confirmed.
- [ ] Local branch is up to date with reviewed main branch state.
- [ ] Required secrets/configuration are present and validated.
- [ ] Any rules/index/function changes are included in deploy plan.
- [ ] Operator has rollback references (last known-good commit/deploy).

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
3. Require branch to be up to date before merge.
4. Restrict direct pushes to `main`.
5. Optionally require at least one approving review.

## CI cache hygiene note

Current CI already caches npm dependencies via `actions/setup-node` using lockfiles. If rules test runtime becomes slow, consider adding a cache for Firebase emulator binaries (`~/.cache/firebase/emulators`) in CI, while keeping workflow complexity low.
