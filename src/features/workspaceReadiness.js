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

  const requiredKeys = ['company', 'location', 'worker', 'aiConfigured'];
  const optionalKeys = ['invite', 'asset'];
  const requiredComplete = requiredKeys.every((key) => checks[key]);
  const requiredCompleteCount = requiredKeys.filter((key) => checks[key]).length;
  const optionalCompleteCount = optionalKeys.filter((key) => checks[key]).length;
  const completionCount = requiredCompleteCount + optionalCompleteCount;

  return {
    checks,
    requiredKeys,
    optionalKeys,
    requiredComplete,
    requiredCompleteCount,
    optionalCompleteCount,
    completionCount,
    totalCount: Object.keys(checks).length,
    requiredTotalCount: requiredKeys.length,
    optionalTotalCount: optionalKeys.length,
    needsSetupWizard: !!company?.id && !requiredComplete,
    hasRequiredGaps: !!company?.id && !requiredComplete
  };
}

function renderCheckRow(label, ok, { optional = false, recommended = false } = {}) {
  const tone = ok ? 'success' : (optional ? 'info' : 'warn');
  const icon = ok ? '✓' : (optional ? '○' : '!');
  const suffix = optional ? ' (optional)' : (recommended ? ' (recommended)' : '');
  return `<div class="tiny"><span class="state-chip ${tone}">${icon}</span> ${label}${suffix}</div>`;
}

export function renderWorkspaceReadinessCard(state = {}, { title = 'Workspace readiness', compact = false, dismissible = false } = {}) {
  const readiness = getWorkspaceReadiness(state);
  const allowDismiss = dismissible && readiness.requiredComplete;
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
      <div class="tiny">Required ${readiness.requiredCompleteCount}/${readiness.requiredTotalCount} | Optional ${readiness.optionalCompleteCount}/${readiness.optionalTotalCount}</div>
    </div>
    ${dismissible ? `<div class="tiny mt">${allowDismiss ? '<button type="button" data-dismiss-readiness="1">Dismiss</button>' : 'Dismiss becomes available when all required readiness items are complete.'}</div>` : ''}
    <div class="mt">${rows}</div>
    ${readiness.requiredComplete
      ? '<div class="inline-state success mt">Core setup complete. Your workspace is operationally ready.</div>'
      : '<div class="inline-state warn mt">Complete company, location, worker, and AI selection to mark setup complete.</div>'}
  </div>`;
}
