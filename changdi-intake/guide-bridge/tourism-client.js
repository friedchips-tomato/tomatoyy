(() => {
  if (!window.crypto?.getRandomValues || !window.fetch || !window.AbortSignal?.timeout) return;
  let pending = 0;

  function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function record(type, subjectId, flowId = newId(), durationSeconds) {
    if (pending >= 8) return;
    pending++;
    try {
      const event = {eventId: newId(), type, subjectId, flowId, occurredAt: new Date().toISOString()};
      if (type === 'guide_played') event.durationSeconds = durationSeconds;
      const response = await fetch('/bridge/tourism-events', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        credentials: 'omit',
        redirect: 'error',
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(4500)
      });
      await response.body?.cancel();
    } catch {
      // Telemetry is best effort and has no effect on the guide UI.
    } finally {
      pending--;
    }
  }

  window.CD_TOURISM = {newId, record};
})();
