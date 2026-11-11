// 서비스 워커: 앱 파일을 항상 서버에서 최신인지 확인하고 받는다.
// 브라우저가 예전 파일을 붙잡고 있어 새 버전이 안 보이는 일을 막는다. 연결이 없을 때만 저장해 둔 사본을 쓴다.
const CACHE = 'golform-files';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // 모델·동기화 서버 등은 건드리지 않는다
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request.url, copy));
        }
        // 서버가 붙인 "10분간 재사용" 지시를 지운다. 그대로 두면 브라우저가 새로고침 때 이 워커에 묻지도 않고 예전 파일을 다시 쓴다.
        const headers = new Headers(res.headers);
        headers.set('Cache-Control', 'no-store');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
      .catch(async () => (await caches.match(e.request.url)) ?? Response.error()),
  );
});
