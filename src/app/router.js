import { pushRouteState } from '../features/workflow.js';

export function tabVisible(tab) {
  const value = tab === 'home' ? 'dashboard' : tab;
  return value || 'dashboard';
}

export function openTab(state, render, name, taskId = null, assetId = null) {
  state.route = {
    ...state.route,
    tab: tabVisible(name),
    taskId: taskId || null,
    assetId: assetId || null,
    pmFilter: null
  };
  pushRouteState(state.route);
  render();
}

export function buildTabs(state, rootEl, render) {
  const tabs = rootEl.querySelector('#tabs');
  tabs.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === tabVisible(state.route.tab);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  tabs.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openTab(state, render, b.dataset.tab)));
}
