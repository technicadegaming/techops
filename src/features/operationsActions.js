export function createOperationsActions({
  state,
  onLocationFilter,
  saveTask,
  reassignTask,
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
