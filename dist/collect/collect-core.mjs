export class AdminError extends Error {
  constructor(message, status = 0, commandId = null) { super(message); this.status = status; this.commandId = commandId; }
}

export function createAdminClient({ fetcher = fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, pollMs = 1500, maxWaitMs = 150000, onProgress = () => {} } = {}) {
  let csrf = '';
  async function request(name, { method = 'GET', body, signal } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', forwardAbort, {once:true});
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
    try {
      const response = await fetcher('../api/' + name, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      let value;
      try { value = await response.json(); } catch { throw new AdminError('服务暂时不可用，请稍后重试。', response.status); }
      if (!response.ok || value.error) throw new AdminError(value.error || '请求未完成。', response.status);
      return value;
    } catch (error) {
      if (timedOut) throw new AdminError('连接超时，操作结果尚未确认，请先刷新状态。');
      if (error instanceof TypeError) throw new AdminError('连接中断，操作结果尚未确认，请先刷新状态。');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort); }
  }
  async function session() {
    try {
      const value = await request('admin-session');
      csrf = value.authenticated ? value.csrf || '' : '';
      return value;
    } catch (error) {
      if (error.status === 401) { csrf = ''; return { authenticated: false }; }
      throw error;
    }
  }
  async function login(key) { await request('admin-session', { method: 'POST', body: { key } }); return session(); }
  async function logout() { await request('admin-session', { method: 'DELETE' }); csrf = ''; }
  async function command(action, payload = {}, { signal, requestId = crypto.randomUUID() } = {}) {
    signal?.throwIfAborted();
    const queued = await request('admin-command', { method: 'POST', body: { action, payload, requestId }, signal });
    if (!queued.id) throw new AdminError('服务未返回操作编号，请刷新确认状态。');
    const id = queued.id;
    const deadline = now() + maxWaitMs;
    let state = queued;
    while (true) {
      signal?.throwIfAborted();
      onProgress({ id, action, status: state.status });
      if (['done', 'completed'].includes(state.status)) return state.result;
      if (['failed', 'expired', 'uncertain', 'cancelled'].includes(state.status)) {
        const messages = { expired: '采集端未及时收到请求，此操作已失效。', uncertain: '执行结果尚未确认，请先刷新状态，勿重复提交。', cancelled: '操作已取消。' };
        throw new AdminError(state.error || messages[state.status] || '采集端未能完成操作。', 0, id);
      }
      if (now() >= deadline) throw new AdminError('仍未收到执行结果，请先刷新状态，勿重复提交。', 0, id);
      await wait(pollMs);
      signal?.throwIfAborted();
      try { state = await request('admin-command?id=' + encodeURIComponent(id), { signal }); }
      catch (error) { error.commandId = id; throw error; }
    }
  }
  return { session, login, logout, state: () => request('admin-state'), command };
}

export function beijingInput(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 19);
}
export function parseBeijing(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const result = Date.parse(value + '+08:00');
  return Number.isFinite(result) && beijingInput(result).slice(0, value.length) === value ? result : null;
}
export function formatBeijing(ms, seconds = false) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return beijingInput(ms).replace('T', ' ').slice(0, seconds ? 19 : 16);
}
export function exportChunk(result) {
  if (!result || typeof result.done !== 'boolean') throw new AdminError('导出数据不完整，请重试。');
  const csv = typeof result.csv === 'string' ? result.csv : Array.isArray(result.rows) ? result.rows.join('\n') + (result.rows.length ? '\n' : '') : '';
  return { header: result.header || '', csv, nextCursor: result.nextCursor ?? null, done: result.done, filename: result.filename || 'sound-atlas-observations.csv' };
}
