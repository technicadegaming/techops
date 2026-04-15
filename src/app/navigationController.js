import { parseRouteState, pushRouteState } from '../features/workflow.js';
import { buildTabs, openTab as openTabUi } from './router.js';

export function createNavigationController({
  state,
  sections,
  canViewAdminTab,
  applyShellFocus,
  documentRef = document
}) {
  function setAdminSection(value) {
    state.adminSection = value;
  }

  function renderTabs() {
    buildTabs({
      state,
      sections,
      canViewAdminTab,
      onOpenTab: openTab,
      documentRef
    });
  }

  function openTab(name, taskId = null, assetId = null) {
    openTabUi({ state, name, taskId, assetId, documentRef });
  }

  function updateRoute(patch = {}) {
    state.route = { ...state.route, ...patch };
    pushRouteState(state.route);
    return state.route;
  }

  function applyShellFocusAndPush(focus) {
    const result = applyShellFocus(focus, { setAdminSection });
    if (result?.routeChanged) pushRouteState(state.route);
    return result;
  }


  function showOperationsForLocation(locationKey) {
    updateRoute({ locationKey, tab: 'operations' });
  }

  function showAssetsForLocation(locationKey) {
    updateRoute({ locationKey, tab: 'assets' });
  }

  function prepareAssetTab() {
    updateRoute({ tab: 'assets', assetId: null, taskId: null });
  }

  function openAdminTools() {
    setAdminSection('tools');
    updateRoute({ tab: 'admin' });
  }

  function syncFromUrl() {
    state.route = parseRouteState();
    openTab(state.route.tab, state.route.taskId, state.route.assetId);
  }

  return {
    applyShellFocusAndPush,
    openAdminTools,
    openTab,
    prepareAssetTab,
    renderTabs,
    setAdminSection,
    showAssetsForLocation,
    showOperationsForLocation,
    syncFromUrl,
    updateRoute
  };
}
