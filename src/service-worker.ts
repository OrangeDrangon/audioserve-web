/// <reference no-default-lib="true"/>
/// <reference lib="es6" />
/// <reference lib="webworker" />
declare var self: ServiceWorkerGlobalScope;

import {
  AUDIO_CACHE_NAME,
  CacheMessageKind,
  AUDIO_CACHE_LIMIT,
} from "./cache/cs-cache";
import { API_CACHE_NAME, API_CACHE_AGE_KEY, APP_CACHE_PREFIX, API_CACHE_LIMIT } from "./types/constants";
import { splitPath } from "./util";
import { AudioCache, CacheFirstCache } from "./util/sw";
import type { CacheMessage } from "./cache/cs-cache";
import { get } from "idb-keyval";

let apiCacheAge = Number.NEGATIVE_INFINITY;
function updateApiCacheAge() {
  get(API_CACHE_AGE_KEY).then((age) => {
    apiCacheAge = age >= 0 ? age : Number.NEGATIVE_INFINITY;
    apiCacheHandler.age = apiCacheAge;
    console.debug(`API cache age is ${apiCacheAge}`);
  });
}

updateApiCacheAge();

function broadcastMessage(msg: CacheMessage) {
  return self.clients
    .matchAll({ includeUncontrolled: true })
    .then((clients) => {
      for (const c of clients) {
        console.debug(`Sending ${msg} to client ${c.type}::${c.id}`);
        c.postMessage(msg);
      }
    });
}

let globalPathPrefix: string = (() => {
  const base = location.pathname;
  const folder = splitPath(base).folder;
  if (folder) {
    return folder + "/";
  } else {
    return "/";
  }
})();

const staticResources = [
  globalPathPrefix,
  "index.html",
  "global.css",
  "favicon.png",
  "bundle.css",
  "bundle.js",
  "app.webmanifest",
  "static/will_sleep_soon.mp3",
  "static/extended.mp3",
];

const COMMIT_HASH_SHORT = "na";
const IS_DEVELOPMENT = true;
const cacheName = APP_CACHE_PREFIX + COMMIT_HASH_SHORT;
const audioCache = AUDIO_CACHE_NAME;
const apiCache = API_CACHE_NAME;

self.addEventListener("install", (evt) => {
  evt.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => {
        return cache.addAll(IS_DEVELOPMENT ? ["favicon.png"] : staticResources);
      })
      .catch(e => console.error("Fail to add static resources due to error: " + e))
      .then(() => {
        console.debug(
          `Service worker Installation successful (dev ${IS_DEVELOPMENT} ) on path ${location.pathname}`
        );
        return self.skipWaiting(); // forces to immediately replace old SW
      })
  );
});

self.addEventListener("activate", (evt) => {
  evt.waitUntil(
    caches
      .keys()
      .then((keyList) => {
        return Promise.all(
          keyList.map((key) => {
            if (key.startsWith("static-") && key != cacheName) {
              return caches.delete(key);
            }
          })
        );
      })
      .then(() => {
        console.debug("Service worker Activation successful");
        return self.clients.claim(); // and forces immediately to take over current page
      })
  );
});

const audioCacheHandler = new AudioCache(
  audioCache,
  AUDIO_CACHE_LIMIT,
  broadcastMessage
);
const apiCacheHandler = new CacheFirstCache(apiCache, API_CACHE_LIMIT, apiCacheAge);

self.addEventListener("message", (evt) => {
  const msg: CacheMessage = evt.data;
  if (msg.kind === CacheMessageKind.Prefetch) {
    audioCacheHandler.handlePrefetch(evt);
  } else if (msg.kind === CacheMessageKind.AbortLoads) {
    audioCacheHandler.abort(msg.data.pathPrefix, msg.data.keepDirect);
  } else if (msg.kind === CacheMessageKind.Ping) {
    console.debug("Got PING from client");
    evt.source?.postMessage({
      kind: CacheMessageKind.Pong,
      data: {
        pendingAudio: audioCacheHandler.getQueue(),
      },
    });
  } else if (msg.kind === CacheMessageKind.UpdateConfig) {
    console.debug("Updating config in SW");
    updateApiCacheAge();
  }
});

const AUDIO_REG_EXP: RegExp = new RegExp(`^${globalPathPrefix}\\d+/audio/`);
const API_REG_EXP: RegExp = new RegExp(
  `^${globalPathPrefix}(\\d+/)?(folder|collections|transcodings)/?`
);

self.addEventListener("fetch", (evt: FetchEvent) => {
  const parsedUrl = new URL(evt.request.url);
  if (AUDIO_REG_EXP.test(parsedUrl.pathname)) {
    console.debug("AUDIO FILE request: ", decodeURI(parsedUrl.pathname));
    // we are not intercepting requests with seek query
    if (parsedUrl.searchParams.get("seek")) return;
    audioCacheHandler.handleRequest(evt);
  } else if (API_REG_EXP.test(parsedUrl.pathname)) {
    console.debug("API request " + parsedUrl.pathname);
    apiCacheHandler.handleRequest(evt);
  } else if (
    parsedUrl.pathname === globalPathPrefix ||
    staticResources.indexOf(
      parsedUrl.pathname.substring(globalPathPrefix.length)
    ) >= 0
  ) {
    evt.respondWith(
      caches.open(cacheName).then((cache) =>
        cache.match(evt.request).then((response) => {
          console.debug(
            `STATIC request: ${parsedUrl.pathname}`,
            evt.request,
            response
          );
          return response || fetch(evt.request);
        })
      )
    );
  } else {
    console.debug(`OTHER request: ${parsedUrl.pathname}`);
  }
});
