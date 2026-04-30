# Stabilization Audit — Scoot Business MVP (2026-04-30)

## Scope
Audit-only pass focused on core live MVP workflows after invite callable hardening work (PR #272).

## Workflows audited
1. Admin → People invite creation
2. Pending invite visibility after refresh
3. Account-first invite acceptance
4. People row display name/email/role/status
5. Worker profile creation/removal and assignability
6. Operations worker assignment dropdown
7. Asset card → "Create task for this asset"
8. Operations task save
9. Operations AI troubleshooting using verified manual chunks
10. Logo/loading/theme shell smoke behavior

## Findings
- No blocking regressions detected in audited workflows under current automated test coverage.
- Invite creation/acceptance remain callable-based (`createCompanyInvite`, `acceptCompanyInvite`) rather than direct client invite writes for creation/acceptance paths.
- Pending invites remain represented through durable data refresh logic after reload.
- Asset "Create task" behavior remains prefill-and-navigate only; it does not directly persist tasks.
- Operations save path remains routed through centralized save action flow.
- Task troubleshooting context prioritization remains grounded in approved/internal manual evidence before web fallback.

## Test evidence run for this audit
- `npm run lint` ✅
- `npm run test:app-shell` ✅
- `npm run test --prefix functions` ✅
- `npm run test:rules` ⚠️ blocked by Firebase emulator artifact download `403 Forbidden` during first-run setup; rules assertions were not executed in this environment.

## Risk notes / follow-up
- Re-run `npm run test:rules` in an environment with emulator artifact download access to fully complete security-rules verification.
- Keep invite/member/worker seams covered with existing app-shell tests when touching onboarding and Admin People flows.
