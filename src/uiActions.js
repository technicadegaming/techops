export function formatActionError(error, fallbackMessage) {
  const detail = `${error?.message || error || ''}`.trim();
  return detail ? `${fallbackMessage} ${detail}` : fallbackMessage;
}

export function runActionFactory({ reportActionError }) {
  return async function runAction(label, work, options = {}) {
    try {
      return await work();
    } catch (error) {
      reportActionError(label, error, options.fallbackMessage || `${label} failed.`);
      if (typeof options.onError === 'function') options.onError(error);
      return null;
    } finally {
      if (typeof options.onFinally === 'function') options.onFinally();
    }
  };
}
