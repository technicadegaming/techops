export function createOperationsActions({
  state,
  onLocationFilter,
  saveTask,
  reassignTask,
  prepareAssetCreation,
  completeTask,
  deleteTask,
  runAi,
  rerunAi,
  submitFollowup,
  saveFix
}) {
  return {
    saveTask,
    reassignTask,
    prepareAssetCreation,
    completeTask,
    deleteTask,
    runAi,
    rerunAi,
    submitFollowup,
    saveFix,
    setLocationFilter: (locationKey) => {
      state.route = { ...state.route, locationKey: locationKey || null };
      if (typeof onLocationFilter === 'function') onLocationFilter(locationKey || null);
    }
  };
}
