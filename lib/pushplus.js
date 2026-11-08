/** PushPlus transport: retry + http fallback, independent of DSH event handling. */
export function createTransport(settings, logger) {
  const postOnce = async (endpoint, title, content) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
    try {
      const body = {
        token: settings.token,
        title,
        content,
        template: settings.template,
      };
      if (settings.channel) body.channel = settings.channel;
      if (settings.to) body.to = settings.to;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      if (response.ok && data?.code === 200) return { ok: true };
      const reason = data?.msg || data?.message || `HTTP ${response.status}`;
      const retryable = !response.ok || response.status === 429 || response.status >= 500;
      return { ok: false, error: reason, retryable };
    } catch (error) {
      const message = error?.name === 'AbortError'
        ? `请求超时 (${settings.timeoutMs} ms)`
        : String(error?.message ?? error);
      return { ok: false, error: message, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  };

  const send = async ({ title, content }) => {
    const endpoints = [settings.endpoint];
    if (settings.fallbackEndpoint) endpoints.push(settings.fallbackEndpoint);

    let lastError = '';
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      for (const endpoint of endpoints) {
        const result = await postOnce(endpoint, title, content);
        if (result.ok) return { ok: true, attempt, endpoint };
        lastError = `${result.error} (${endpoint})`;
        logger.warn(`第 ${attempt}/${settings.maxAttempts} 次尝试失败: ${result.error} (${endpoint})`);
        if (!result.retryable) return { ok: false, error: result.error };
      }
      if (attempt < settings.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, settings.retryDelayMs * attempt));
      }
    }
    return { ok: false, error: lastError };
  };

  return { send };
}
