// Service worker de «Hilo rojo». Sustituye al que genera Godot (tools/exportar_web.js lo copia como
// index.service.worker.js y rellena los valores marcados con @...@).
//   · Sirve el juego desde la caché: arranca sin esperar a la red y funciona sin conexión.
//   · Las actualizaciones se descargan enteras en segundo plano mientras se juega a la versión anterior;
//     sólo entonces se activan, así que la siguiente vez que se abre ya es la nueva y nunca queda una
//     caché a medias (sin conexión seguiría arrancando).
//   · Lo que no ha cambiado entre versiones (normalmente el motor, 40 MB) se copia de la caché anterior
//     en lugar de descargarse: cada archivo lleva su huella (MD5) en HASHES.
//   · Al terminar la primera carga, la página le pide que guarde también el motor y el juego
//     («completar»), sin descargarlos dos veces a la vez.
//   · Copia limpia de las respuestas redirigidas (p. ej. Cloudflare Pages redirige index.html a /), que
//     el navegador no acepta para abrir una página.
'use strict';

const VERSION = "1791997839958";
const PREFIX = "Hilo rojo-sw-cache-";
const CACHE = PREFIX + VERSION;
const PAGE = 'index.html';
const OFFLINE = "index.offline.html";
// Archivos pequeños (página, cargador, página sin conexión, iconos): se guardan al instalar.
const CORE = ["index.html","index.js","index.offline.html","index.icon.png","index.apple-touch-icon.png","index.audio.worklet.js","index.audio.position.worklet.js","index.manifest.json","index.144x144.png","index.180x180.png","index.512x512.png"];
// Motor (wasm) y juego (pck): en una actualización, al instalar; en la primera visita, al acabar de cargar.
const HEAVY = ["index.wasm","index.pck"];
const ALL = CORE.concat(HEAVY);
// Huella de cada archivo de esta versión.
const HASHES = {"index.html":"abde888483a8ac6942f6a478b937236a","index.js":"304c6a520d2dbc82062dc50ef6a695bf","index.offline.html":"14f82785dc6d902971b20997d11f1107","index.icon.png":"95fa94d3822e3e8099902b86019e70cc","index.apple-touch-icon.png":"b2af883edbaf2431581a1da395ff3500","index.audio.worklet.js":"c55ea38b7dbd5eb296a8353e7e360ae9","index.audio.position.worklet.js":"8a7370a54ea5758d957875cbeb24416c","index.manifest.json":"d1f10582988cb8733216388cbb068a46","index.144x144.png":"d5a49ac73c395efb1487b8d9fc6f5ba3","index.180x180.png":"63831cbe7194e722944a1d8ef9ff0da9","index.512x512.png":"720cfddeb65da1b02b1f500879d56c10","index.wasm":"83e2f97ab834d857572e3da40d56e70d","index.pck":"04f12ecdc4043aa14620ecd50ae93e6a"};
const HASH_HEADER = 'X-Hilo-Rojo-Huella';

// Copia de la respuesta con su huella (y sin la marca de redirección).
async function stamped(name, res) {
	const headers = new Headers(res.headers);
	headers.set(HASH_HEADER, HASHES[name] || '');
	return new Response(await res.blob(), { status: 200, statusText: 'OK', headers: headers });
}

// El mismo archivo, idéntico, en la caché de una versión anterior.
async function previous(name) {
	if (!HASHES[name]) {
		return null;
	}
	for (const key of await caches.keys()) {
		if (!key.startsWith(PREFIX) || key === CACHE) {
			continue;
		}
		const old = await (await caches.open(key)).match(name);
		if (old && old.headers.get(HASH_HEADER) === HASHES[name]) {
			return old;
		}
	}
	return null;
}

async function store(cache, name) {
	const old = await previous(name);
	if (old) {
		await cache.put(name, old);
		return;
	}
	// «no-cache»: siempre se pregunta al servidor (si no ha cambiado, responde 304 sin volver a enviarlo).
	const res = await fetch(new Request(name, { cache: 'no-cache' }));
	if (!res.ok) {
		throw new Error(name + ': ' + res.status);
	}
	await cache.put(name, await stamped(name, res));
}

async function storeMissing(cache, names) {
	for (const name of names) {
		if (!(await cache.match(name))) {
			await store(cache, name);
		}
	}
}

self.addEventListener('install', (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(CACHE);
		const update = !!self.registration.active;
		await storeMissing(cache, update ? ALL : CORE);
		// Completa: ya puede sustituir a la anterior (la página abierta sigue con lo que cargó).
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		const keys = await caches.keys();
		await Promise.all(keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((key) => caches.delete(key)));
		// El service worker de Godot activaba la precarga de navegación (la página se pedía a la red en
		// cada apertura aunque saliera de la caché); éste no la usa.
		if (self.registration.navigationPreload) {
			await self.registration.navigationPreload.disable();
		}
	})());
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') {
		return;
	}
	const url = new URL(req.url);
	const scope = new URL(self.registration.scope);
	if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) {
		return;
	}
	const rel = url.pathname.slice(scope.pathname.length);
	const isPage = req.mode === 'navigate' && (rel === '' || rel === PAGE);
	const name = isPage ? PAGE : rel;
	if (!isPage && !ALL.includes(name)) {
		return;
	}
	event.respondWith((async () => {
		const cache = await caches.open(CACHE);
		if (isPage) {
			// Sin todo el juego en caché, la página sale de la red (y, si no hay red, la de sin conexión).
			const stored = await Promise.all(ALL.map((n) => cache.match(n)));
			if (stored.some((r) => !r)) {
				try {
					return await fetch(req);
				} catch (e) {
					return (await cache.match(OFFLINE)) || Response.error();
				}
			}
		}
		const hit = await cache.match(name);
		if (hit) {
			return hit;
		}
		const res = await fetch(req);
		if (res.ok && !isPage) {
			// Se guarda en paralelo: la página recibe la respuesta (y su progreso) sin esperar.
			event.waitUntil(stamped(name, res.clone()).then((copy) => cache.put(name, copy)).catch(() => {}));
		}
		return res;
	})());
});

self.addEventListener('message', (event) => {
	if (event.origin !== self.location.origin) {
		return;
	}
	const msg = event.data || '';
	if (msg === 'completar') {
		event.waitUntil(caches.open(CACHE).then((cache) => storeMissing(cache, ALL)).catch(() => {}));
	} else if (msg === 'claim' || msg === 'update') {
		// Mensajes del propio Godot (OS.pwa_update): activar la versión nueva y, con «update», recargar.
		event.waitUntil(self.skipWaiting().then(() => self.clients.claim()).then(() => {
			if (msg === 'update') {
				return self.clients.matchAll({ type: 'window' }).then((all) => all.forEach((c) => c.navigate(c.url)));
			}
			return null;
		}));
	} else if (msg === 'clear') {
		event.waitUntil(caches.delete(CACHE));
	}
});
