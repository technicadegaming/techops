import { renderReports } from '../features/reports.js';
import { upsertEntity } from '../data.js';

export function createReportsController({
  state,
  navigationController
}) {
  function applyReportFocus(focus) {
    return navigationController.applyShellFocusAndPush(focus);
  }

  function navigateToReportTarget(tab, taskId = null, assetId = null) {
    return navigationController.openTab(tab, taskId, assetId);
  }

  function createDependencies() {
    return {
      applyFocus: applyReportFocus,
      navigate: navigateToReportTarget,
      upsertIncidentReport: (id, payload, user) => upsertEntity('incidentReports', id, payload, user)
    };
  }

  return {
    createDependencies,
    renderReportsSection(element) {
      const { navigate, applyFocus } = createDependencies();
      renderReports(element, state, navigate, applyFocus, createDependencies());
    }
  };
}
