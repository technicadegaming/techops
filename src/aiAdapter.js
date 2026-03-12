// Placeholder abstraction for future server-side AI integration.
// Never place provider API keys in frontend code.
export async function requestTaskSuggestions({ task, settings }) {
  return {
    taskId: task?.id || null,
    status: 'not_implemented',
    reason: 'Phase 2 will call a secure backend endpoint that holds AI credentials.',
    settingsUsed: settings
  };
}
