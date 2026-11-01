const CACHE = 'levromart-shell-v{{asset-version}}';
const RUNTIME = 'levromart-runtime-v10';
const OFFLINE_FALLBACK = '/';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    try {
      await cache.addAll([
        OFFLINE_FALLBACK,
        '/manifest.json',
        '/levromart-notification-icon.png',
        '/levromart-badge.png'
      ]);
    } catch (e) {}

    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter(k => ![CACHE, RUNTIME].includes(k) && !k.startsWith('levromart-runtime-v'))
        .map(k => caches.delete(k))
    );

    await self.clients.claim();
  })());
});

function isImageRequest(request) {
  return (
    request.destination === 'image' ||
    /\.(?:png|jpe?g|webp|gif|svg|ico)(?:\?|$)/i.test(
      new URL(request.url).pathname
    )
  );
}

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /*
   * Navigation requests:
   * Ask the network first, but only wait a short while (1.2 s). A normal
   * connection therefore always opens the newest version straight away, with
   * no flash of an older look. On a slow or missing connection the saved copy
   * opens instead, and the fresh copy is kept for next time (the open page
   * is told to reload itself if it is still untouched).
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const saved =
          (await cache.match(request)) ||
          (await cache.match(OFFLINE_FALLBACK));

        const refresh = fetch(request)
          .then(async fresh => {
            if (!(fresh && fresh.ok)) return null;
            let newer = false;
            if (saved) {
              try {
                const [a, b] = await Promise.all([saved.clone().text(), fresh.clone().text()]);
                newer = a !== b;
              } catch (e) {}
            }
            await cache.put(request, fresh.clone()).catch(() => {});
            return { fresh, newer };
          })
          .catch(() => null);

        if (saved) {
          const quick = await Promise.race([
            refresh,
            new Promise(resolve => setTimeout(() => resolve(null), 1200))
          ]);
          if (quick && quick.fresh) return quick.fresh;

          event.waitUntil(
            refresh.then(async done => {
              if (done && done.newer) {
                const open = await self.clients.matchAll({ type: 'window' });
                open.forEach(c => c.postMessage({ type: 'LV_APP_UPDATED' }));
              }
            })
          );
          return saved;
        }

        const done = await refresh;
        return (
          (done && done.fresh) ||
          new Response(
            'Levromart is offline.',
            {
              status: 503,
              headers: {
                'Content-Type': 'text/plain'
              }
            }
          )
        );
      })()
    );

    return;
  }

  /*
   * Runtime caching for images, same-origin resources,
   * CDNs and fonts.
   */
  if (
    isImageRequest(request) ||
    url.origin === location.origin ||
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);

        // A stylesheet or script must really be one. During a deploy a not-yet-published file can be answered with the
        // app's own page (status 200); keeping that would leave the screen unstyled or broken until the next version.
        const wantsKind = request.destination === 'style' ? 'css' : request.destination === 'script' ? 'javascript' : '';
        const looksRight = response => !wantsKind || response.type === 'opaque' || (response.headers.get('content-type') || '').includes(wantsKind);

        let cached = await cache.match(request);
        if (cached && !looksRight(cached)) {
          await cache.delete(request).catch(() => {});
          cached = undefined;
        }

        const network = fetch(request)
          .then(response => {
            if (
              response &&
              looksRight(response) &&
              (
                response.ok ||
                response.type === 'opaque'
              )
            ) {
              cache
                .put(request, response.clone())
                .catch(() => {});
            }

            return response;
          })
          .catch(() => null);

        return (
          cached ||
          await network ||
          new Response('', {
            status: 504
          })
        );
      })()
    );
  }
});


/*
 * ============================================================
 * WEB PUSH NOTIFICATIONS
 * ============================================================
 *
 * This listener receives push messages from the push service
 * and displays the Levromart notification.
 *
 * The dedicated Levromart notification icon prevents Android
 * from falling back to a generic white-square notification icon.
 */

self.addEventListener('push', event => {
  event.waitUntil(
    (async () => {

      let data = {};

      try {
        data = event.data
          ? event.data.json()
          : {};
      } catch (_) {

        try {
          data = {
            body: event.data
              ? event.data.text()
              : ''
          };
        } catch (_) {}
      }


      // While the app is open and on screen, everything shows inside the app instead (calls still ring).
      if (data && !data.call && data.tag !== 'levromart-incoming-call') {
        try {
          const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          if (open.some(c => c.visibilityState === 'visible')) return;
        } catch (_) {}
      }

      const declarative = data && data.web_push === 8030 && data.notification
        ? data.notification
        : null;

      const title = String(
        data.title ||
        declarative?.title ||
        'Levromart'
      );


      const body = String(
        data.body ||
        declarative?.body ||
        'You have a new Levromart update.'
      );


      const url = String(
        data.url ||
        declarative?.navigate ||
        '/'
      );


      /*
       * Levromart notification icon.
       */
      const icon = String(
        data.icon ||
        declarative?.icon ||
        '/levromart-notification-icon.png'
      );


      /*
       * Monochrome notification badge.
       */
      const badge = String(
        data.badge ||
        declarative?.badge ||
        '/levromart-badge.png'
      );


      // If a rich option is rejected on some phones, still show a plain notification
      // (a push that ends without showing anything is what makes alerts "disappear").
      const showRich = () => self.registration.showNotification(
        title,
        {
          body,

          icon,

          badge,

          // Incoming calls get Answer / Decline buttons right on the notification.
          actions: Array.isArray(data.actions) ? data.actions : (Array.isArray(declarative?.actions) ? declarative.actions : undefined),

          data: {
            url,
            call: data.call || null,
            // Carried straight through from the push payload so a tap can
            // route the already-open app in-app (see notificationclick
            // below) instead of only ever having a bare URL to work with.
            target_view: data.target_view || data.targetView || declarative?.target_view || declarative?.targetView,
            target_params: data.target_params || data.targetParams || declarative?.target_params || declarative?.targetParams,
            metadata: data.metadata || data.meta || declarative?.metadata
          },

          tag: data.tag
            ? String(data.tag)
            : (declarative?.tag ? String(declarative.tag) : `levromart-${Date.now()}`),

          renotify: true,

          silent: data.silent === true || declarative?.silent === true,

          requireInteraction: data.requireInteraction === true || declarative?.requireInteraction === true,

          timestamp: Number(data.timestamp || Date.now()),

          vibrate: (data.requireInteraction === true || declarative?.requireInteraction === true)
            ? [400, 200, 400, 200, 400, 200, 400]
            : [
            100,
            50,
            100
          ]
        }
      );
      return showRich().catch(() => self.registration.showNotification(title, { body, icon: '/levromart-notification-icon.png', requireInteraction: data.requireInteraction === true, vibrate: [400, 200, 400, 200, 400], tag: data.tag ? String(data.tag) : undefined, renotify: true, data: { url } }));

    })()
  );
});


/*
 * ============================================================
 * NOTIFICATION CLICK
 * ============================================================
 *
 * When the user taps a Levromart notification:
 * 1. Close the notification.
 * 2. Focus an existing Levromart window if possible.
 * 3. Navigate it to the notification URL.
 * 4. Otherwise open a new window.
 */

self.addEventListener('notificationclick', event => {

  event.notification.close();


  const notifData = event.notification?.data || {};
  const target = notifData.url || '/';

  // "Decline" on an incoming call: reject it without opening the app.
  if (event.action === 'decline' && notifData.call && notifData.call.id) {
    event.waitUntil(
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'decline-call', callId: notifData.call.id, token: notifData.call.token })
      }).catch(() => {})
    );
    return;
  }


  event.waitUntil(
    (async () => {

      const clientsList =
        await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        });


      for (
        const client
        of clientsList
      ) {

        if ('focus' in client) {

          // The app is already open and listens for exactly this message,
          // turning target_view/target_params into an in-app navigate() --
          // no reload. client.navigate() used to hard-reload the whole SPA
          // from scratch just to land on one notification's page, wiping
          // out whatever the person was already doing.
          try {
            client.postMessage({
              type: 'PUSH_NOTIFICATION_CLICK',
              ...notifData
            });
          } catch (_) {}

          return client.focus();
        }
      }


      if (self.clients.openWindow) {

        return self.clients.openWindow(
          new URL(
            target,
            self.location.origin
          ).href
        );

      }

    })()
  );
});
