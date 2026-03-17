import { buildTabs } from './router.js';

export function renderShell(state, elements, render) {
  buildTabs(state, document, render);
  const roleLabel = state.permissions.companyRole || state.profile?.role || 'pending';
  document.getElementById('userBadge').textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` | ${state.company.name}` : ''}`;
  elements.activeCompanySwitcher?.classList.toggle('hide', !(state.memberships || []).length);
}
