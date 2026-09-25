(function () {
  'use strict';

  const config = window.KILN_CLOUD_CONFIG;
  const appScript = document.currentScript?.dataset.app;
  const email = 'ivan@firesmartroofing.com';
  const OUTBOX_KEY = 'kiln-planner-cloud-outbox-v1';
  const syncKeys = new Set([
    'kiln-planner-active-order-v1',
    'kiln-planner-order-archive-v1',
    'kiln-planner-remainder-inventory-v1',
    'kiln-planner-completed-cycles-v1',
    'kiln-planner-shipping-tags-v1',
    'kiln-planner-tag-sequence-v1',
    'kiln-planner-recovery-operations-v1',
    'kiln-planner-test-boards-v1',
    'kiln-planner-preliminary-orders-v1',
    'kiln-planner-shipments-v1',
    'kiln-planner-final-process-date-v1',
    'kiln-planner-supplier-profiles-v1',
    'kiln-planner-last-supplier-v1',
    'kiln-planner-order-index-v1',
  ]);
  const syncPrefixes = ['kiln-planner-order-v1:'];
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  let client;
  let userId = '';
  let appLoaded = false;
  let cloudReady = false;
  let reloadScheduled = false;
  let outboxRetryTimer = 0;
  const seenRevisions = new Map();
  const pushTimers = new Map();
  const pendingValues = new Map();
  const activePushes = new Set();
  const pushChains = new Map();
  let navigationProtected = false;
  let storagePatched = false;
  function isSyncKey(key) { return syncKeys.has(key) || syncPrefixes.some((prefix) => String(key).startsWith(prefix)); }
  function localSyncKeys() {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((key) => key && isSyncKey(key));
  }

  function setLocal(key, value) { nativeSet.call(localStorage, key, value); }
  function removeLocal(key) { nativeRemove.call(localStorage, key); }
  function parseLocal(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
  function json(value) { return JSON.stringify(value); }
  function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]));
    }
    return value;
  }
  function sameStoredValue(left, right) {
    if (left === right) return true;
    if (left === null || right === null) return false;
    try {
      return JSON.stringify(normalizeJson(JSON.parse(left))) === JSON.stringify(normalizeJson(JSON.parse(right)));
    } catch (_) {
      return false;
    }
  }

  function readOutbox() {
    try {
      const value = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (_) {
      return {};
    }
  }

  function writeOutbox(value) {
    if (Object.keys(value).length) nativeSet.call(localStorage, OUTBOX_KEY, JSON.stringify(value));
    else nativeRemove.call(localStorage, OUTBOX_KEY);
  }

  function stageOutbox(key, operation) {
    const outbox = readOutbox();
    outbox[key] = operation;
    writeOutbox(outbox);
  }

  function clearOutboxOperation(key, operation) {
    const outbox = readOutbox();
    if (!outbox[key] || json(normalizeJson(outbox[key])) !== json(normalizeJson(operation))) return;
    delete outbox[key];
    writeOutbox(outbox);
  }

  function hasOutboxOperations() { return Object.keys(readOutbox()).length > 0; }

  function addStatus(text, state = 'online') {
    let bar = document.getElementById('cloudStatusBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'cloudStatusBar';
      bar.innerHTML = `<span></span><b></b><button type="button">Sign out</button>`;
      bar.querySelector('button').addEventListener('click', async () => { await client.auth.signOut(); window.location.reload(); });
      document.body.prepend(bar);
    }
    bar.dataset.state = state;
    bar.querySelector('span').textContent = state === 'online' ? '●' : '○';
    bar.querySelector('b').textContent = text;
  }

  function loadApplication() {
    if (appLoaded || !appScript) return;
    appLoaded = true;
    document.body.classList.remove('cloud-locked');
    const script = document.createElement('script');
    script.src = appScript;
    document.body.appendChild(script);
  }

  function showLogin(message = '') {
    document.body.classList.add('cloud-locked');
    const overlay = document.createElement('div');
    overlay.className = 'cloud-login';
    overlay.innerHTML = `<form><small>AUTHORIZED PRODUCTION ACCESS</small><h1>Kiln Load Planner</h1><p>Sign in to open the shared production order.</p><label>Email<input type="email" value="${email}" autocomplete="username" required></label><label>Password<input type="password" autocomplete="current-password" required autofocus></label><div class="cloud-login-message">${message}</div><button type="submit">Sign in</button></form>`;
    document.body.appendChild(overlay);
    overlay.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = overlay.querySelector('button');
      const messageBox = overlay.querySelector('.cloud-login-message');
      button.disabled = true;
      button.textContent = 'Signing in…';
      const fields = overlay.querySelectorAll('input');
      const { data, error } = await client.auth.signInWithPassword({ email: fields[0].value.trim(), password: fields[1].value });
      if (error) {
        messageBox.textContent = error.message;
        button.disabled = false;
        button.textContent = 'Sign in';
        return;
      }
      userId = data.user.id;
      overlay.remove();
      await startSharedApplication();
    });
  }

  async function pushState(key, value) {
    if (!cloudReady || !isSyncKey(key)) return;
    const operation = { type: 'set', value };
    const { error } = await client.from(config.table).upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) {
      addStatus('Production changes are not yet saved — stay on this screen', 'offline');
      scheduleOutboxRetry();
      throw error;
    }
    clearOutboxOperation(key, operation);
    addStatus(`Shared as ${email}`, 'online');
  }

  function queueCloudOperation(key, operation) {
    const previous = pushChains.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    pushChains.set(key, task);
    activePushes.add(task);
    const cleanup = () => {
      activePushes.delete(task);
      if (pushChains.get(key) === task) pushChains.delete(key);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  function trackPush(key, value) { return queueCloudOperation(key, () => pushState(key, value)); }

  function trackDelete(key) {
    return queueCloudOperation(key, async () => {
      const { error } = await client.from(config.table).delete().eq('key', key);
      if (error) {
        addStatus('Production changes are not yet saved — stay on this screen', 'offline');
        scheduleOutboxRetry();
        throw error;
      }
      clearOutboxOperation(key, { type: 'delete' });
    });
  }

  async function replayOutbox() {
    const operations = Object.entries(readOutbox()).filter(([key]) => isSyncKey(key));
    for (const [key, operation] of operations) {
      if (operation?.type === 'delete') {
        const { error } = await client.from(config.table).delete().eq('key', key);
        if (error) throw error;
      } else {
        const value = operation?.value;
        const { error } = await client.from(config.table).upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'key' });
        if (error) throw error;
      }
      clearOutboxOperation(key, operation);
    }
  }

  function scheduleOutboxRetry() {
    if (outboxRetryTimer || !hasOutboxOperations()) return;
    outboxRetryTimer = window.setTimeout(async () => {
      outboxRetryTimer = 0;
      try {
        await replayOutbox();
        addStatus(`Shared as ${email}`, 'online');
      } catch (error) {
        console.error('Protected production changes are still waiting for cloud sync:', error);
        addStatus('Connected — production changes are protected locally and waiting to sync', 'offline');
        scheduleOutboxRetry();
      }
    }, 5000);
  }

  async function flushPendingState() {
    const pending = [...pendingValues.entries()];
    pending.forEach(([key]) => {
      window.clearTimeout(pushTimers.get(key));
      pushTimers.delete(key);
      pendingValues.delete(key);
    });
    const pendingTasks = pending.map(([key, value]) => trackPush(key, value));
    await Promise.all(pendingTasks);
    if (activePushes.size) await Promise.all([...activePushes]);
    if (hasOutboxOperations()) await replayOutbox();
  }

  function protectInternalNavigation() {
    if (navigationProtected) return;
    navigationProtected = true;
    document.addEventListener('click', async (event) => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.download) return;
      const destination = new URL(link.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
      if (!pendingValues.size && !activePushes.size && !hasOutboxOperations()) return;
      event.preventDefault();
      addStatus('Saving production changes before opening the next screen…', 'offline');
      try {
        await flushPendingState();
        window.location.assign(destination.href);
      } catch (error) {
        console.error('Navigation paused until production changes are saved:', error);
        addStatus('Could not save production changes. This page was kept open; try again.', 'offline');
      }
    });
  }

  function patchStorage() {
    if (storagePatched) return;
    storagePatched = true;
    Storage.prototype.setItem = function (key, value) {
      const previous = this === localStorage ? localStorage.getItem(key) : null;
      nativeSet.call(this, key, value);
      if (this === localStorage && isSyncKey(key) && previous !== String(value)) {
        stageOutbox(key, { type: 'set', value: parseLocal(key) });
        window.clearTimeout(pushTimers.get(key));
        pendingValues.set(key, parseLocal(key));
        pushTimers.set(key, window.setTimeout(() => {
          pushTimers.delete(key);
          const pending = pendingValues.get(key);
          pendingValues.delete(key);
          trackPush(key, pending).catch(() => {});
        }, 250));
      }
    };
    Storage.prototype.removeItem = function (key) {
      nativeRemove.call(this, key);
      if (this === localStorage && isSyncKey(key) && cloudReady) {
        stageOutbox(key, { type: 'delete' });
        pendingValues.delete(key);
        trackDelete(key).catch(() => {});
      }
    };
  }

  async function pullSharedState() {
    const { data, error } = await client.from(config.table).select('key,value,updated_at');
    if (error) throw error;
    if (!data.length) {
      const seed = localSyncKeys().map((key) => ({ key, value: parseLocal(key), updated_by: userId, updated_at: new Date().toISOString() }));
      if (seed.length) {
        const result = await client.from(config.table).upsert(seed, { onConflict: 'key' });
        if (result.error) throw result.error;
      }
      return;
    }
    // Never replace a locally protected mutation with an older cloud row.
    // Other keys can still refresh normally, so one pending write does not
    // disconnect the entire planner.
    const protectedKeys = new Set(Object.keys(readOutbox()));
    localSyncKeys().forEach((key) => { if (!protectedKeys.has(key)) removeLocal(key); });
    data.forEach((row) => {
      if (!isSyncKey(row.key)) return;
      seenRevisions.set(row.key, row.updated_at || '');
      if (protectedKeys.has(row.key)) return;
      setLocal(row.key, typeof row.value === 'string' ? row.value : json(row.value));
    });
  }

  function subscribe() {
    client.channel('kiln-shared-state').on('postgres_changes', { event: '*', schema: 'public', table: config.table }, (payload) => {
      const key = payload.new?.key || payload.old?.key;
      if (!isSyncKey(key)) return;
      const revision = payload.new?.updated_at || '';
      if (revision && revision <= (seenRevisions.get(key) || '')) return;
      if (revision) seenRevisions.set(key, revision);
      const remoteValue = payload.new ? (typeof payload.new.value === 'string' ? payload.new.value : json(payload.new.value)) : null;
      const localValue = localStorage.getItem(key);
      if (sameStoredValue(remoteValue, localValue)) return;
      if (remoteValue === null) removeLocal(key); else setLocal(key, remoteValue);
      addStatus('Updated on another computer — refreshing…', 'online');
      if (reloadScheduled) return;
      reloadScheduled = true;
      window.setTimeout(() => window.location.reload(), 700);
    }).subscribe();
  }

  async function startSharedApplication() {
    addStatus('Connecting shared production data…', 'offline');
    try {
      await pullSharedState();
      cloudReady = true;
      patchStorage();
      protectInternalNavigation();
      subscribe();
      window.kilnCloudFlush = flushPendingState;
      if (hasOutboxOperations()) {
        addStatus('Connected — recovering protected production changes…', 'offline');
        try {
          await replayOutbox();
          addStatus(`Shared as ${email}`, 'online');
        } catch (error) {
          console.error('Protected production changes are waiting for cloud sync:', error);
          addStatus('Connected — production changes are protected locally and waiting to sync', 'offline');
          scheduleOutboxRetry();
        }
      } else addStatus(`Shared as ${email}`, 'online');
    } catch (error) {
      console.error('Supabase synchronization failed:', error);
      // Continue recording every production mutation in the durable outbox.
      // A later reload or explicit flush can replay it without data loss.
      cloudReady = true;
      patchStorage();
      protectInternalNavigation();
      window.kilnCloudFlush = flushPendingState;
      addStatus('Cloud unavailable — changes are protected locally', 'offline');
    }
    loadApplication();
  }

  async function boot() {
    if (['127.0.0.1', 'localhost'].includes(window.location.hostname)) {
      loadApplication();
      return;
    }
    if (!config || !window.supabase) {
      showLogin('Cloud configuration could not be loaded.');
      return;
    }
    client = window.supabase.createClient(config.url, config.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await client.auth.getSession();
    if (!data.session) { showLogin(); return; }
    userId = data.session.user.id;
    await startSharedApplication();
  }

  boot();
})();
