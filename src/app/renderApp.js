import { buildTabs } from './router.js';
import { sections } from './state.js';

export function renderShell(state, elements, onOpenTab) {
  buildTabs({
    state,
    sections,
    canViewAdminTab: () => state.permissions?.companyRole === 'owner' || state.permissions?.companyRole === 'admin' || state.permissions?.globalRole === 'admin',
    onOpenTab,
    documentRef: document
  });
  const roleLabel = state.permissions.companyRole || state.profile?.role || 'pending';
  document.getElementById('userBadge').textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` | ${state.company.name}` : ''}`;
  elements.activeCompanySwitcher?.classList.toggle('hide', !(state.memberships || []).length);
}
