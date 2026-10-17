// Service worker do Bafômetro ao Vivo: funciona offline e trata o toque nas notificações
const CACHE = 'bafometro-v6';
const SHELL = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Rede primeiro (para pegar atualizações), cache se estiver offline
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !isFont) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
      return res;
    } catch {
      return (await cache.match(req.mode === 'navigate' ? './index.html' : req, { ignoreSearch: true })) || Response.error();
    }
  })());
});

// Lembrete vindo do servidor (funciona com o app fechado)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const title = d.title || 'Hora da próxima?';
  const base = { body: d.body || 'Toque para adicionar +1 da última bebida.', icon: 'icon-192.png', tag: d.tag || 'bafometro-lembrete', data: { token: d.token || '' } };
  e.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, { ...base, badge: 'icon-192.png', renotify: true,
        actions: d.token ? [{ action: 'add', title: '+1' }, { action: 'skip', title: 'Agora não' }] : [] });
    } catch {
      // alguns navegadores (iOS) recusam opções extras: mostra a versão simples
      await self.registration.showNotification(title, base);
    }
  })());
});

// Toque na notificação: adiciona +1 da última bebida
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'skip') return;
  const token = (e.notification.data && e.notification.data.token) || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      w.postMessage({ type: 'add-last', token });
      try { await w.focus(); } catch {}
      return;
    }
    await self.clients.openWindow(new URL('./?add=' + encodeURIComponent(token), self.registration.scope).href);
  })());
});
