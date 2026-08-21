(function () {
  'use strict';

  const config = window.KILN_CLOUD_CONFIG;
  const appScript = document.currentScript?.dataset.app;
  const email = 'ivan@firesmartroofing.com';
  const syncKeys = new Set([
    'kiln-planner-active-order-v1',
    'kiln-planner-order-archive-v1',
    'kiln-planner-completed-cycles-v1',
    'kiln-planner-shipping-tags-v1',
    'kiln-planner-shipments-v1',
    'kiln-planner-final-process-date-v1',
    'kiln-planner-supplier-profiles-v1',
    'kiln-planner-last-supplier-v1',
  ]);
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;
  let client;
  let userId = '';
  let appLoaded = false;
  let cloudReady = false;

  function setLocal(key, value) { nativeSet.call(localStorage, key, value); }
  function removeLocal(key) { nativeRemove.call(localStorage, key); }
  function parseLocal(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (_) { return raw; }
  }
  function json(value) { return JSON.stringify(value); }

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
    if (!cloudReady || !syncKeys.has(key)) return;
    const { error } = await client.from(config.table).upsert({ key, value, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) addStatus('Offline changes pending', 'offline');
    else addStatus(`Shared as ${email}`, 'online');
  }

  function patchStorage() {
    Storage.prototype.setItem = function (key, value) {
      nativeSet.call(this, key, value);
      if (this === localStorage && syncKeys.has(key)) pushState(key, parseLocal(key));
    };
    Storage.prototype.removeItem = function (key) {
      nativeRemove.call(this, key);
      if (this === localStorage && syncKeys.has(key) && cloudReady) {
        client.from(config.table).delete().eq('key', key).then(({ error }) => {
          if (error) addStatus('Offline deletion pending', 'offline');
        });
      }
    };
  }

  async function pullSharedState() {
    const { data, error } = await client.from(config.table).select('key,value');
    if (error) throw error;
    if (!data.length) {
      const seed = [...syncKeys].filter((key) => localStorage.getItem(key) !== null).map((key) => ({ key, value: parseLocal(key), updated_by: userId, updated_at: new Date().toISOString() }));
      if (seed.length) {
        const result = await client.from(config.table).upsert(seed, { onConflict: 'key' });
        if (result.error) throw result.error;
      }
      return;
    }
    syncKeys.forEach(removeLocal);
    data.forEach((row) => setLocal(row.key, typeof row.value === 'string' ? row.value : json(row.value)));
  }

  function subscribe() {
    client.channel('kiln-shared-state').on('postgres_changes', { event: '*', schema: 'public', table: config.table }, (payload) => {
      const key = payload.new?.key || payload.old?.key;
      if (!syncKeys.has(key)) return;
      const remoteValue = payload.new ? (typeof payload.new.value === 'string' ? payload.new.value : json(payload.new.value)) : null;
      const localValue = localStorage.getItem(key);
      if (remoteValue === localValue || (remoteValue === null && localValue === null)) return;
      if (remoteValue === null) removeLocal(key); else setLocal(key, remoteValue);
      addStatus('Updated on another computer — refreshing…', 'online');
      window.setTimeout(() => window.location.reload(), 700);
    }).subscribe();
  }

  async function startSharedApplication() {
    addStatus('Connecting shared production data…', 'offline');
    try {
      await pullSharedState();
      cloudReady = true;
      patchStorage();
      subscribe();
      addStatus(`Shared as ${email}`, 'online');
    } catch (error) {
      console.error('Supabase synchronization failed:', error);
      addStatus('Cloud unavailable — local backup mode', 'offline');
    }
    loadApplication();
  }

  async function boot() {
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
