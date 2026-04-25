import { pushRouteState } from '../features/workflow.js';

export function tabVisible(state, tab, canViewAdminTab) {
  if (state.onboardingRequired) return tab === 'dashboard';
  if (tab === 'admin') return canViewAdminTab();
  return true;
}

export function buildTabs({ state, sections, canViewAdminTab, onOpenTab, documentRef = document }) {
  const labelMap = {
    dashboard: 'Workspace · Dashboard',
    operations: 'Workspace · Operations',
    assets: 'Workspace · Assets',
    calendar: 'Workspace · Calendar & PM',
    reports: 'Admin · Reports',
    account: 'Admin · Account',
    admin: 'Admin · Settings'
  };
  const tabs = documentRef.getElementById('tabs');
  tabs.innerHTML = sections
    .filter((section) => tabVisible(state, section, canViewAdminTab))
    .map((id) => `<button class="tab ${id === state.route.tab ? 'active' : ''}" data-tab="${id}">${labelMap[id] || id}</button>`)
    .join('');
  tabs.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => onOpenTab(button.dataset.tab)));
}

export function openTab({ state, name, taskId = null, assetId = null, documentRef = document }) {
  state.route = { ...state.route, tab: name, taskId: taskId || null, assetId: assetId || null };
  pushRouteState(state.route);
  documentRef.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  documentRef.querySelectorAll('.section').forEach((section) => section.classList.toggle('active', section.id === name));
  if (taskId) setTimeout(() => documentRef.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
  if (assetId) setTimeout(() => documentRef.getElementById(`asset-${assetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
}
