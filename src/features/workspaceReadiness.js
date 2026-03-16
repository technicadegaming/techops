export function getWorkspaceReadiness(state = {}) {
  const company = state.company || null;
  const locations = state.companyLocations || [];
  const workers = state.workers || [];
  const invites = state.invites || [];
  const assets = state.assets || [];
  const settings = state.settings || {};

  const checks = {
    company: !!company?.id,
    location: locations.length > 0,
    worker: workers.length > 0,
    invite: invites.some((invite) => invite.status === 'pending'),
    asset: assets.length > 0,
    aiConfigured: settings.aiConfiguredExplicitly === true
  };

  const requiredComplete = checks.company && checks.location && checks.worker && checks.aiConfigured;
  const completionCount = Object.values(checks).filter(Boolean).length;

  return {
    checks,
    requiredComplete,
    completionCount,
    totalCount: Object.keys(checks).length,
    needsSetupWizard: !!company?.id && !requiredComplete
  };
}

function renderCheckRow(label, ok, { optional = false, recommended = false } = {}) {
  const tone = ok ? 'success' : (optional ? 'info' : 'warn');
  const icon = ok ? '✓' : (optional ? '○' : '!');
  const suffix = optional ? ' (optional)' : (recommended ? ' (recommended)' : '');
  return `<div class="tiny"><span class="state-chip ${tone}">${icon}</span> ${label}${suffix}</div>`;
}

export function renderWorkspaceReadinessCard(state = {}, { title = 'Workspace readiness', compact = false } = {}) {
  const readiness = getWorkspaceReadiness(state);
  const rows = [
    renderCheckRow('Company profile', readiness.checks.company),
    renderCheckRow('At least one location', readiness.checks.location),
    renderCheckRow('At least one worker', readiness.checks.worker),
    renderCheckRow('Invite created', readiness.checks.invite, { optional: true }),
    renderCheckRow('At least one asset', readiness.checks.asset, { optional: true, recommended: true }),
    renderCheckRow('AI enabled/disabled chosen', readiness.checks.aiConfigured)
  ].join('');

  return `<div class="item ${compact ? '' : 'mt'}">
    <div class="row space">
      <b>${title}</b>
      <div class="tiny">${readiness.completionCount}/${readiness.totalCount} complete</div>
    </div>
    <div class="mt">${rows}</div>
    ${readiness.requiredComplete
      ? '<div class="inline-state success mt">Core setup complete. Your workspace is operationally ready.</div>'
      : '<div class="inline-state warn mt">Complete company, location, worker, and AI selection to mark setup complete.</div>'}
  </div>`;
}
