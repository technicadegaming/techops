export function createOperationsActions({
  state,
  onLocationFilter,
  saveTask,
  appendTaskTimeline,
  reassignTask,
  prepareAssetCreation,
  completeTask,
  deleteTask,
  uploadTaskEvidence,
  removeTaskEvidence,
  runAi,
  rerunAi,
  submitFollowup,
  saveFix,
  setAiFixState,
  openAiSettings,
  signOffChecklistItemWithPin
}) {
  return {
    saveTask,
    appendTaskTimeline,
    reassignTask,
    prepareAssetCreation,
    completeTask,
    deleteTask,
    uploadTaskEvidence,
    removeTaskEvidence,
    runAi,
    rerunAi,
    submitFollowup,
    saveFix,
    setAiFixState,
    openAiSettings,
    signOffChecklistItemWithPin,
    setLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey: locationKey || null };
      if (typeof onLocationFilter === 'function') onLocationFilter(locationKey || null);
    }
  };
}
