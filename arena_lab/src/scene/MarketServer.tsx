/**
 * ЗАДАЧА 7.2 — API /parts, /builds · БЭКЕНД МАРКЕТПЛЕЙСА (FORMULA I1)
 * ============================================================================
 * Платформа. Реализация серверной части маркетплейса тюнинга для dev-режима:
 * те же маршруты, что ждёт клиент `TuningMarket.tsx`, но исполняемые прямо в
 * браузере поверх `fetch` (без внешнего процесса). Это закрывает «дыру» между
 * типизированным API-клиентом (7.2) и реальным хранилищем: клиент звал
 * `/api/parts` и `/api/builds`, но бэкенда в проекте не было — павильон всегда
 * падал в offline-фолбэк.
 *
 * Схема данных (совет Оракула):
 *   • `parts.json`  — каталог деталей (Part[]);
 *   • `builds.json` — опубликованные сборки (Build[]);
 *   • **экономика/комиссия 30% — НА БЭКЕНДЕ**, а не в UI: при публикации
 *     сборки сервер считает `price`, `commission = round(price * 0.30)` и
 *     `payout = price − commission`. Клиент комиссию не изобретает.
 *
 * Маршруты:
 *   GET  /api/parts[?category=engine|aero|tyres|brakes|suspension]
 *   GET  /api/builds[?owner=<agentId>]
 *   GET  /api/builds/:id
 *   POST /api/builds            (тело: BuildDraft; owner берётся из JWT)
 *
 * Приёмы из research/racing-game (MIT):
 *   - src/data.ts — вынос статики (цвета/пресеты) в отдельный модуль-каталог;
 *   - src/ui/LeaderBoard.tsx — серверное поле `rating` для сортировки витрины.
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import {
  DEFAULT_BUILDS,
  DEFAULT_PARTS,
  type Build,
  type BuildDraft,
  type BuildItem,
  type Part,
  type PartCategory,
} from './TuningMarket';

/* -------------------------------------------------------------------------- */
/*  Экономика маркетплейса (комиссия — только тут, на «бэкенде»)              */
/* -------------------------------------------------------------------------- */

/** Комиссия платформы с продажи сборки. */
export const COMMISSION_RATE = 0.3;

/** Разбивка стоимости опубликованной сборки. */
export interface BuildPricing {
  price: number;
  commission: number;
  payout: number;
}

/** Считает цену сборки по каталогу и удерживает комиссию платформы. */
export function priceBuild(draft: BuildDraft, catalog: Part[] = DEFAULT_PARTS): BuildPricing {
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const price = draft.parts.reduce((sum, item) => sum + (byId.get(item.part_id)?.price ?? 0), 0);
  const commission = Math.round(price * COMMISSION_RATE);
  return { price, commission, payout: price - commission };
}

/* -------------------------------------------------------------------------- */
/*  «Файлы» хранилища: parts.json / builds.json                               */
/* -------------------------------------------------------------------------- */

/** Содержимое parts.json (каталог деталей). */
export const PARTS_JSON: string = JSON.stringify(DEFAULT_PARTS, null, 2);

/** Содержимое builds.json (опубликованные сборки). */
export const BUILDS_JSON: string = JSON.stringify(DEFAULT_BUILDS, null, 2);

interface MarketDb {
  parts: Part[];
  builds: Build[];
  seq: number;
}

/** In-memory база (аналог чтения parts.json/builds.json при старте сервера). */
function createDb(): MarketDb {
  return {
    parts: JSON.parse(PARTS_JSON) as Part[],
    builds: JSON.parse(BUILDS_JSON) as Build[],
    seq: 1,
  };
}

let db: MarketDb | null = null;
function getDb(): MarketDb {
  if (!db) db = createDb();
  return db;
}

/** Сброс состояния (полезно в тестах и при hot-reload). */
export function resetMarketDb(): void {
  db = createDb();
}

/* -------------------------------------------------------------------------- */
/*  Ответы и разбор запроса                                                   */
/* -------------------------------------------------------------------------- */

interface MarketReply {
  status: number;
  body: unknown;
}

const json = (status: number, body: unknown): MarketReply => ({ status, body });

/** Достаёт `owner` из Bearer-JWT (payload.sub / payload.email), без верификации. */
export function ownerFromAuth(header: string | null | undefined): string {
  if (!header) return 'guest';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const payload = token.split('.')[1];
  if (!payload) return 'guest';
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const normalized = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const jsonStr =
      typeof atob === 'function'
        ? atob(normalized)
        : Buffer.from(normalized, 'base64').toString('binary');
    const data = JSON.parse(jsonStr) as { sub?: string; email?: string; id?: string };
    return data.sub || data.email || data.id || 'guest';
  } catch {
    return 'guest';
  }
}

/* -------------------------------------------------------------------------- */
/*  Обработчики маршрутов                                                     */
/* -------------------------------------------------------------------------- */

function listParts(search: URLSearchParams): MarketReply {
  const category = search.get('category') as PartCategory | null;
  const parts = category ? getDb().parts.filter((p) => p.category === category) : getDb().parts;
  return json(200, parts);
}

function listBuilds(search: URLSearchParams): MarketReply {
  const owner = search.get('owner');
  const builds = owner ? getDb().builds.filter((b) => b.owner === owner) : getDb().builds;
  const sorted = [...builds].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return json(200, sorted);
}

function getBuild(id: string): MarketReply {
  const build = getDb().builds.find((b) => b.id === id);
  return build ? json(200, build) : json(404, { error: 'build_not_found', id });
}

function createBuild(draft: BuildDraft, owner: string): MarketReply {
  if (!draft || typeof draft.name !== 'string' || !Array.isArray(draft.parts)) {
    return json(400, { error: 'invalid_draft', message: 'name и parts обязательны' });
  }
  const known = new Set(getDb().parts.map((p) => p.id));
  const items: BuildItem[] = draft.parts.filter((p) => p && known.has(p.part_id));
  if (items.length === 0) {
    return json(422, { error: 'no_valid_parts', message: 'нет ни одной известной детали' });
  }

  const pricing = priceBuild({ name: draft.name, parts: items });
  const store = getDb();
  const build: Build & Partial<BuildPricing> = {
    id: `bld_${Date.now().toString(36)}_${store.seq++}`,
    owner,
    name: draft.name,
    parts: items,
    rating: 0,
    createdAt: Date.now(),
    ...pricing,
  };
  store.builds.push(build);
  return json(201, build);
}

/* -------------------------------------------------------------------------- */
/*  Роутер: path → handler (возвращает null для «не наш» путь)                 */
/* -------------------------------------------------------------------------- */

export function routeMarket(
  pathname: string,
  search: URLSearchParams,
  method: string,
  init: RequestInit,
): MarketReply | null {
  // Маршрут считается нашим, если после /api/ идёт parts или builds.
  const match = /\/api\/(parts|builds)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  const [, resource, id] = match;
  const m = method.toUpperCase();

  if (resource === 'parts') {
    if (m !== 'GET') return json(405, { error: 'method_not_allowed' });
    return listParts(search);
  }

  // resource === 'builds'
  if (m === 'GET') return id ? getBuild(decodeURIComponent(id)) : listBuilds(search);
  if (m === 'POST' && !id) {
    let draft: BuildDraft | null = null;
    try {
      draft = init.body ? (JSON.parse(String(init.body)) as BuildDraft) : null;
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    const headers = new Headers(init.headers as HeadersInit | undefined);
    const owner = ownerFromAuth(headers.get('authorization'));
    return draft ? createBuild(draft, owner) : json(400, { error: 'empty_body' });
  }
  return json(405, { error: 'method_not_allowed' });
}

/* -------------------------------------------------------------------------- */
/*  Установка перехватчика fetch (идемпотентно)                               */
/* -------------------------------------------------------------------------- */

let installed = false;

/**
 * Патчит `window.fetch`, обслуживая /api/parts и /api/builds локально.
 * Все прочие запросы (auth, socket.io-предзагрузки и т.п.) делегируются
 * исходному `fetch` без изменений.
 */
export function installMarketServer(): boolean {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') {
    return false;
  }
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL | null = null;
    try {
      url = new URL(rawUrl, window.location.origin);
    } catch {
      url = null;
    }
    if (!url) return originalFetch(input, init);

    const reply = routeMarket(url.pathname, url.searchParams, init.method ?? 'GET', init);
    if (!reply) return originalFetch(input, init);

    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  installed = true;
  return true;
}

/** Снят только флаг (для тестов): позволяет переустановить сервер. */
export function __resetMarketServerFlag(): void {
  installed = false;
}
