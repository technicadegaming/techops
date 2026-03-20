import { buildLocationOptions, getLocationSelection, getLocationScopeLabel } from '../features/locationContext.js';

export function createContextSwitcherController({
  state,
  elements = {},
  setActiveMembership,
  pushRouteState,
  render,
  runAction,
  documentRef = document
}) {
  const {
    activeCompanySwitcher,
    activeLocationSwitcher,
    locationScopeBadge
  } = elements;

  function renderActiveLocationSwitcher() {
    if (!activeLocationSwitcher || !locationScopeBadge) return;
    const options = buildLocationOptions(state);
    const selection = getLocationSelection(state);
    locationScopeBadge.textContent = getLocationScopeLabel(selection);
    activeLocationSwitcher.innerHTML = options
      .map((option) => `<option value="${option.key}" ${option.key === selection?.key ? 'selected' : ''}>${option.label}</option>`)
      .join('');
    activeLocationSwitcher.onchange = (event) => {
      state.route = { ...state.route, locationKey: `${event.target.value || ''}`.trim() || null };
      pushRouteState(state.route);
      render();
    };
  }

  function renderActiveCompanySwitcher() {
    if (!activeCompanySwitcher) return;
    const memberships = state.memberships || [];
    if (memberships.length <= 1 || state.onboardingRequired) {
      activeCompanySwitcher.classList.add('hide');
      activeCompanySwitcher.innerHTML = '';
      activeCompanySwitcher.onchange = null;
      return;
    }

    activeCompanySwitcher.classList.remove('hide');
    activeCompanySwitcher.innerHTML = memberships.map((membership) => {
      const companyName = state.membershipCompanies?.[membership.id]?.name || membership.companyId || 'Unknown company';
      const role = membership.role || 'pending';
      return `<option value="${membership.id}" ${membership.id === state.activeMembership?.id ? 'selected' : ''}>${companyName} (${role})</option>`;
    }).join('');
    activeCompanySwitcher.onchange = async (event) => {
      const nextId = `${event.target.value || ''}`.trim();
      if (!nextId || nextId === state.activeMembership?.id) return;
      await runAction('switch_company', async () => {
        await setActiveMembership(nextId);
      }, {
        fallbackMessage: 'Unable to switch company workspace.'
      });
    };
  }

  function renderHeaderContext() {
    const roleLabel = state.permissions.companyRole || state.profile?.role || 'pending';
    renderActiveCompanySwitcher();
    renderActiveLocationSwitcher();
    const userBadge = documentRef.getElementById('userBadge');
    if (userBadge && state.user?.email) {
      userBadge.textContent = `${state.user.email} (${roleLabel})${state.company?.name ? ` | ${state.company.name}` : ''}`;
    }
  }

  return {
    renderActiveCompanySwitcher,
    renderActiveLocationSwitcher,
    renderHeaderContext
  };
}
