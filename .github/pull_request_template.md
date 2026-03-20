## Summary
- 

## Change type
- [ ] Docs/process-only change
- [ ] Functions/backend behavior change
- [ ] Frontend/app-shell change
- [ ] Rules/security-boundary change
- [ ] Release/deploy workflow change

## Checks run
- [ ] `npm run lint`
- [ ] `npm run test --prefix functions`
- [ ] `npm run test:app-shell` (required when touching `src/app.js`, `src/app/*`, or shell/controller seams)
- [ ] `npm run test:rules` (required when touching rules or tenant/security-sensitive boundaries)

## Applicability notes
- App-shell tests applicable? `yes/no`:
- Rules tests applicable? `yes/no`:
- If a conditional check was not run, why:

## Docs consulted
- [ ] `README.md`
- [ ] `docs/DATA_MODEL.md`
- [ ] `docs/FRONTEND_STRUCTURE.md`
- [ ] `docs/DEPLOYMENT.md`
- [ ] `docs/SECURITY.md`
- [ ] `docs/APP_SHELL_REMAINING_SEAMS.md`
- [ ] `docs/RELEASE_CHECKLIST.md`

## Risk / follow-up
- Risk level: low / medium / high
- Rollback or manual follow-up notes:
