const CACHE_NAME = "raycaster-v1";
const PRECACHE = [ "/neongame.html", "/manifest.webmanifest" ];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(resp => {
        caches.open(CACHE_NAME).then(c => c.put(request, resp.clone())).catch(()=>{});
        return resp;
      }).catch(() => {
        // 👇 para navegaciones, devolvé el HTML del juego
        if (request.mode === "navigate") return caches.match("/neongame.html");
        return new Response("", { status: 504, statusText: "Offline" });
      });
    })
  );
});
