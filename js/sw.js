importScripts('https://storage.googleapis.com/workbox-cdn/releases/6.5.3/workbox-sw.js');

if (workbox && workbox.routing) {
  console.log('✅ Workbox is loaded in SW');

  workbox.routing.registerRoute(
    new RegExp('^https://proxy\\.rivestream\\.net/.*$'),
    new workbox.strategies.NetworkOnly()
  );
} else {
  console.error('❌ Workbox failed to load');
}