/**
 * ЗАДАЧА 7.1 — СХЕМА БД: parts, builds · МАРКЕТПЛЕЙС ТЮНИНГА (FORMULA I1)
 * ============================================================================
 * Этап «Маркетплейс тюнинга». Пока вся платформа хранила домены в flat-JSON
 * (`memory/*.json`), маркетплейс рождается уже реляционным: две «боевые»
 * таблицы `parts` и `builds` + связка `build_items` (сборка = набор слотов).
 *
 * Что даёт этот модуль:
 *   • ROW-ТИПЫ `PartRow` / `BuildRow` / `BuildItemRow` — контракт данных;
 *   • РЕЕСТР `MARKET_TABLES` (колонки/PK/индексы/enum) — единственный
 *     источник правды по структуре БД;
 *   • ГЕНЕРАТОР DDL (sqlite | postgres) + проверку целостности схемы;
 *   • SEED-КАТАЛОГ `PARTS_SEED` / `BUILDS_SEED` / `BUILD_ITEMS_SEED`
 *     (то, что бэкенд кладёт в parts.json / builds.json);
 *   • (де)СЕРИАЛИЗАЦИЮ `parts.json` / `builds.json` с нормализацией и
 *     устойчивостью к мусору (parsePartsJson / parseBuildsJson);
 *   • ЭКОНОМИКУ: `MARKET_COMMISSION_RATE = 0.30` (30 % — комиссия ПЛАТФОРМЫ,
 *     начисляется ТОЛЬКО на бэкенде) и `priceBuild()` для расчёта разбивки;
 *   • 3D-ТАБЛО `MarketSchemaBoard` — визуальная карточка схемы в сцене.
 *
 * Приёмы-референсы (research/racing-game, MIT):
 *   – src/ui/LeaderBoard.tsx — табличный листинг на примитивах;
 *   – src/ui/Speed/Gauge.tsx — LED-панель без внешних моделей.
 * Код собственный, в терминах проекта AI-1.
 *
 * Reference: web/server.js (роуты /api/*), arena_lab/src/scene/DbSchema.tsx
 * (общий реестр 6.2), TuningMarket.tsx (API-клиент 7.2).
 * ============================================================================
 */

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import * as THREE from 'three';

/** Версия схемы маркетплейса — растёт при несовместимой миграции. */
export const MARKET_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/*  1. Типы строк (row-типы)                                                  */
/* -------------------------------------------------------------------------- */

export type PartCategory = 'engine' | 'aero' | 'tyres' | 'brakes' | 'suspension';

/** Все допустимые категории-слоты (один болид = 5 слотов). */
export const PART_CATEGORIES: readonly PartCategory[] = [
  'engine',
  'aero',
  'tyres',
  'brakes',
  'suspension',
];

/** Характеристики детали (0..10). Все шкалы опциональны. */
export interface PartStats {
  speed?: number;
  accel?: number;
  grip?: number;
  handling?: number;
  reliability?: number;
}

export type PartStatKey = keyof PartStats;

/** Строка таблицы `parts` — тюнинг-деталь каталога. */
export interface PartRow {
  id: string;
  name: string;
  category: PartCategory;
  /** Уровень 1..5. */
  tier: number;
  /** Цена в кредитах. */
  price: number;
  stats: PartStats;
  description: string | null;
  stock: number;
  created_at: number | null;
}

/** Строка таблицы `builds` — опубликованная сборка болида. */
export interface BuildRow {
  id: string;
  /** Владелец (агент/пилот). Кросс-ссылка на agents.name в общей схеме (6.2). */
  owner: string;
  name: string;
  created_at: number;
  updated_at: number | null;
  /** Сумма цен деталей. */
  subtotal: number;
  /** Комиссия платформы (30 % от subtotal) — проставляется бэкендом. */
  commission: number;
  /** Итог, который платит покупатель (== subtotal). */
  total_price: number;
  /** Средний рейтинг сообщества 0..5. */
  rating: number | null;
  is_public: boolean;
}

/** Строка таблицы `build_items` — слот сборки. Композитный PK. */
export interface BuildItemRow {
  build_id: string;
  slot: PartCategory;
  part_id: string;
}

/** Ссылка на деталь внутри JSON-документа сборки (без build_id). */
export interface BuildItemRef {
  slot: PartCategory;
  part_id: string;
}

/** JSON-документ сборки: строка `builds` + вложенный список слотов. */
export interface BuildDoc extends BuildRow {
  parts: BuildItemRef[];
}

/* -------------------------------------------------------------------------- */
/*  2. Реестр схемы: таблицы / колонки / индексы                              */
/* -------------------------------------------------------------------------- */

export type ColumnType = 'text' | 'int' | 'epoch_ms' | 'real' | 'bool' | 'json';

export interface ColumnRef {
  table: string;
  column: string;
}

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  pk?: boolean;
  unique?: boolean;
  nullable?: boolean;
  default?: string | number | boolean;
  ref?: ColumnRef;
  enumOf?: readonly string[];
  comment?: string;
}

export interface IndexSpec {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface TableSpec {
  name: string;
  comment: string;
  columns: ColumnSpec[];
  indexes?: IndexSpec[];
}

/** Реестр схемы маркетплейса: parts / builds / build_items. */
export const MARKET_TABLES: readonly TableSpec[] = [
  {
    name: 'parts',
    comment: 'Каталог тюнинг-деталей (memory/market/parts.json)',
    columns: [
      { name: 'id', type: 'text', pk: true, comment: 'slug, напр. eng_v8_biturbo' },
      { name: 'name', type: 'text', comment: 'отображаемое имя' },
      { name: 'category', type: 'text', enumOf: PART_CATEGORIES, comment: 'слот болида' },
      { name: 'tier', type: 'int', default: 1, comment: 'уровень 1..5' },
      { name: 'price', type: 'int', default: 0, comment: 'кредиты' },
      { name: 'stats', type: 'json', default: '{}', comment: 'PartStats как JSON' },
      { name: 'description', type: 'text', nullable: true },
      { name: 'stock', type: 'int', default: 0, comment: 'доступно на складе' },
      { name: 'created_at', type: 'epoch_ms', nullable: true },
    ],
    indexes: [
      { name: 'ix_parts_category', columns: ['category'] },
      { name: 'ix_parts_tier', columns: ['tier'] },
    ],
  },
  {
    name: 'builds',
    comment: 'Опубликованные сборки болидов (memory/market/builds.json)',
    columns: [
      { name: 'id', type: 'text', pk: true },
      { name: 'owner', type: 'text', comment: 'agents.name (общая схема 6.2)' },
      { name: 'name', type: 'text' },
      { name: 'created_at', type: 'epoch_ms' },
      { name: 'updated_at', type: 'epoch_ms', nullable: true },
      { name: 'subtotal', type: 'int', default: 0 },
      { name: 'commission', type: 'int', default: 0, comment: '30% — только бэкенд' },
      { name: 'total_price', type: 'int', default: 0 },
      { name: 'rating', type: 'real', nullable: true },
      { name: 'is_public', type: 'bool', default: true },
    ],
    indexes: [
      { name: 'ix_builds_owner', columns: ['owner'] },
      { name: 'ix_builds_created', columns: ['created_at'] },
      { name: 'ix_builds_public_rating', columns: ['is_public', 'rating'] },
    ],
  },
  {
    name: 'build_items',
    comment: 'Слоты сборки (BuildItem). Композитный PK (build_id, slot).',
    columns: [
      { name: 'build_id', type: 'text', pk: true, ref: { table: 'builds', column: 'id' } },
      { name: 'slot', type: 'text', pk: true, enumOf: PART_CATEGORIES },
      { name: 'part_id', type: 'text', ref: { table: 'parts', column: 'id' } },
    ],
    indexes: [{ name: 'ix_build_items_part', columns: ['part_id'] }],
  },
];

/* -------------------------------------------------------------------------- */
/*  3. Генератор DDL (sqlite | postgres)                                      */
/* -------------------------------------------------------------------------- */

export type SqlDialect = 'sqlite' | 'postgres';

const SQL_TYPES: Record<SqlDialect, Record<ColumnType, string>> = {
  sqlite: {
    text: 'TEXT',
    int: 'INTEGER',
    epoch_ms: 'INTEGER',
    real: 'REAL',
    bool: 'INTEGER',
    json: 'TEXT',
  },
  postgres: {
    text: 'TEXT',
    int: 'INTEGER',
    epoch_ms: 'BIGINT',
    real: 'DOUBLE PRECISION',
    bool: 'BOOLEAN',
    json: 'JSONB',
  },
};

function defaultLiteral(dialect: SqlDialect, value: string | number | boolean): string {
  if (typeof value === 'boolean') {
    return dialect === 'sqlite' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  }
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** SQL одной колонки. */
export function columnSql(dialect: SqlDialect, col: ColumnSpec): string {
  const parts = [col.name, SQL_TYPES[dialect][col.type]];
  if (col.pk || !col.nullable) parts.push('NOT NULL');
  if (col.unique) parts.push('UNIQUE');
  if (col.default !== undefined) parts.push(`DEFAULT ${defaultLiteral(dialect, col.default)}`);
  if (col.ref) parts.push(`REFERENCES ${col.ref.table}(${col.ref.column})`);
  return '  ' + parts.join(' ');
}

/** SQL CREATE TABLE одной таблицы (колонки + составной PK + FK). */
export function createTableSql(dialect: SqlDialect, table: TableSpec): string {
  const lines = table.columns.map((c) => columnSql(dialect, c));
  const pks = table.columns.filter((c) => c.pk).map((c) => c.name);
  if (pks.length) lines.push(`  PRIMARY KEY (${pks.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${lines.join(',\n')}\n);`;
}

/** Полный DDL маркетплейса для выбранного диалекта + индексы. */
export function createMarketSchemaSql(dialect: SqlDialect = 'sqlite'): string {
  const out: string[] = [
    `-- MarketSchema v${MARKET_SCHEMA_VERSION} (${dialect}) — generated, do not edit by hand`,
  ];
  for (const t of MARKET_TABLES) {
    out.push('');
    out.push(`-- ${t.comment}`);
    out.push(createTableSql(dialect, t));
    for (const ix of t.indexes || []) {
      const uniq = ix.unique ? 'UNIQUE ' : '';
      out.push(`CREATE ${uniq}INDEX IF NOT EXISTS ${ix.name} ON ${t.name} (${ix.columns.join(', ')});`);
    }
  }
  return out.join('\n');
}

/** Готовый DDL для sqlite — то, что применяет бэкенд web/server.js. */
export const MARKET_DDL_SQLITE = createMarketSchemaSql('sqlite');
/** Готовый DDL для postgres (прод). */
export const MARKET_DDL_POSTGRES = createMarketSchemaSql('postgres');

/* -------------------------------------------------------------------------- */
/*  4. Целостность схемы                                                      */
/* -------------------------------------------------------------------------- */

/** Проверка реестра: PK/дубли/FK-цели/enum/index-колонки. */
export function validateMarketSchema(schema: readonly TableSpec[] = MARKET_TABLES): string[] {
  const problems: string[] = [];
  const seenTables = new Set<string>();

  for (const t of schema) {
    if (seenTables.has(t.name)) problems.push(`duplicate table: ${t.name}`);
    seenTables.add(t.name);

    const cols = new Set<string>();
    for (const c of t.columns) {
      if (cols.has(c.name)) problems.push(`${t.name}: duplicate column ${c.name}`);
      cols.add(c.name);
    }
    if (!t.columns.some((c) => c.pk)) problems.push(`${t.name}: no primary key`);

    for (const c of t.columns) {
      if (c.unique && c.pk) problems.push(`${t.name}.${c.name}: unique redundant with pk`);
      if (c.enumOf && c.type !== 'text') problems.push(`${t.name}.${c.name}: enumOf on non-text`);
      if (!c.ref) continue;
      const target = schema.find((x) => x.name === c.ref!.table);
      if (!target) {
        problems.push(`${t.name}.${c.name}: FK -> missing table ${c.ref.table}`);
      } else if (!target.columns.some((x) => x.name === c.ref!.column)) {
        problems.push(`${t.name}.${c.name}: FK -> missing column ${c.ref.table}.${c.ref.column}`);
      }
    }

    for (const ix of t.indexes || []) {
      for (const ic of ix.columns) {
        if (!cols.has(ic)) problems.push(`${t.name}: index ${ix.name} on missing column ${ic}`);
      }
    }
  }
  return problems;
}

/** Статистика реестра для HUD/тестов. */
export function marketSchemaStats(schema: readonly TableSpec[] = MARKET_TABLES) {
  let columns = 0;
  let foreignKeys = 0;
  let indexes = 0;
  let enums = 0;
  for (const t of schema) {
    columns += t.columns.length;
    foreignKeys += t.columns.filter((c) => !!c.ref).length;
    indexes += (t.indexes || []).length;
    enums += t.columns.filter((c) => !!c.enumOf).length;
  }
  return { tables: schema.length, columns, foreignKeys, indexes, enums };
}

/* -------------------------------------------------------------------------- */
/*  5. Экономика: комиссия платформы 30 %                                     */
/* -------------------------------------------------------------------------- */

/**
 * Комиссия платформы с каждой проданной сборки. 30 % удерживаются
 * ИСКЛЮЧИТЕЛЬНО на бэкенде (web/server.js) — клиент только отображает.
 */
export const MARKET_COMMISSION_RATE = 0.3;

export interface BuildPricing {
  /** Сумма цен деталей. */
  subtotal: number;
  /** Комиссия платформы (30 % от subtotal). */
  commission: number;
  /** Выплата автору сборки (70 % от subtotal). */
  payout: number;
  /** Итоговая цена для покупателя (== subtotal). */
  total: number;
}

/** Расчёт разбивки цены сборки по списку её деталей. */
export function priceBuild(parts: ReadonlyArray<Pick<PartRow, 'price'>>): BuildPricing {
  const subtotal = parts.reduce((sum, p) => sum + (Number.isFinite(p.price) ? p.price : 0), 0);
  const commission = Math.round(subtotal * MARKET_COMMISSION_RATE);
  return { subtotal, commission, payout: subtotal - commission, total: subtotal };
}

/* -------------------------------------------------------------------------- */
/*  6. SEED-каталог (parts.json / builds.json)                                */
/* -------------------------------------------------------------------------- */

/** Стартовый каталог деталей. ID согласованы с TuningMarket.tsx (7.2). */
export const PARTS_SEED: PartRow[] = [
  {
    id: 'eng_v8_biturbo',
    name: 'V8 Biturbo',
    category: 'engine',
    tier: 4,
    price: 4200,
    stats: { speed: 9, accel: 8, reliability: 7 },
    description: 'Флагманский двигатель FORMULA I1.',
    stock: 3,
    created_at: Date.now() - 30 * 86_400_000,
  },
  {
    id: 'aero_wing_rear',
    name: 'Rear Wing MK-II',
    category: 'aero',
    tier: 3,
    price: 1800,
    stats: { grip: 8, handling: 6 },
    description: 'Прижимная сила на выходе из поворота.',
    stock: 12,
    created_at: Date.now() - 25 * 86_400_000,
  },
  {
    id: 'tyres_soft_c3',
    name: 'Soft Slicks C3',
    category: 'tyres',
    tier: 2,
    price: 950,
    stats: { grip: 9, reliability: 5 },
    description: 'Максимальный пик сцепления на один отрезок.',
    stock: 24,
    created_at: Date.now() - 20 * 86_400_000,
  },
  {
    id: 'brakes_carbon',
    name: 'Carbon Ceramic',
    category: 'brakes',
    tier: 4,
    price: 2100,
    stats: { handling: 8, reliability: 8 },
    description: 'Углерод-керамика, стабильность на длинной дистанции.',
    stock: 6,
    created_at: Date.now() - 15 * 86_400_000,
  },
  {
    id: 'susp_active',
    name: 'Active Suspension',
    category: 'suspension',
    tier: 5,
    price: 3400,
    stats: { grip: 7, handling: 9 },
    description: 'Активная подвеска с адаптацией к профилю трассы.',
    stock: 2,
    created_at: Date.now() - 10 * 86_400_000,
  },
];

/** Стартовые сборки (публичный лидерборд маркетплейса). */
export const BUILDS_SEED: BuildRow[] = [
  {
    id: 'bld_apex',
    owner: 'agent_3',
    name: 'Apex Predator',
    created_at: Date.now() - 86_400_000,
    updated_at: null,
    subtotal: 6000,
    commission: 1800,
    total_price: 6000,
    rating: 4.8,
    is_public: true,
  },
  {
    id: 'bld_grip',
    owner: 'agent_7',
    name: 'Grip Monster',
    created_at: Date.now() - 43_200_000,
    updated_at: null,
    subtotal: 4350,
    commission: 1305,
    total_price: 4350,
    rating: 4.5,
    is_public: true,
  },
  {
    id: 'bld_budget',
    owner: 'agent_1',
    name: 'Budget Bullet',
    created_at: Date.now() - 7_200_000,
    updated_at: null,
    subtotal: 2100,
    commission: 630,
    total_price: 2100,
    rating: 3.9,
    is_public: true,
  },
];

/** Слоты стартовых сборок (table build_items). */
export const BUILD_ITEMS_SEED: BuildItemRow[] = [
  { build_id: 'bld_apex', slot: 'engine', part_id: 'eng_v8_biturbo' },
  { build_id: 'bld_apex', slot: 'aero', part_id: 'aero_wing_rear' },
  { build_id: 'bld_grip', slot: 'tyres', part_id: 'tyres_soft_c3' },
  { build_id: 'bld_grip', slot: 'suspension', part_id: 'susp_active' },
  { build_id: 'bld_budget', slot: 'brakes', part_id: 'brakes_carbon' },
];

/* -------------------------------------------------------------------------- */
/*  7. (де)Сериализация parts.json / builds.json                              */
/* -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCategory(value: unknown): value is PartCategory {
  return typeof value === 'string' && (PART_CATEGORIES as readonly string[]).includes(value);
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanStats(value: unknown): PartStats {
  const src = asRecord(value);
  const out: PartStats = {};
  const keys: PartStatKey[] = ['speed', 'accel', 'grip', 'handling', 'reliability'];
  for (const k of keys) {
    const n = optNum(src[k]);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** Нормализация строки детали из JSON. Возвращает null, если нет id. */
export function normalizePartRow(raw: unknown): PartRow | null {
  const r = asRecord(raw);
  const id = typeof r.id === 'string' && r.id ? r.id : null;
  if (!id) return null;
  return {
    id,
    name: typeof r.name === 'string' && r.name ? r.name : id,
    category: isCategory(r.category) ? r.category : 'engine',
    tier: Math.max(1, Math.min(5, Math.round(num(r.tier, 1)))),
    price: Math.max(0, Math.round(num(r.price, 0))),
    stats: cleanStats(r.stats),
    description: typeof r.description === 'string' ? r.description : null,
    stock: Math.max(0, Math.round(num(r.stock, 0))),
    created_at: optNum(r.created_at),
  };
}

/** Нормализация документа сборки из JSON. Возвращает null, если нет id/owner. */
export function normalizeBuildDoc(raw: unknown): BuildDoc | null {
  const r = asRecord(raw);
  const id = typeof r.id === 'string' && r.id ? r.id : null;
  const owner = typeof r.owner === 'string' && r.owner ? r.owner : null;
  if (!id || !owner) return null;

  const parts: BuildItemRef[] = [];
  for (const item of asArray(r.parts)) {
    const ir = asRecord(item);
    if (!isCategory(ir.slot)) continue;
    if (typeof ir.part_id !== 'string' || !ir.part_id) continue;
    parts.push({ slot: ir.slot, part_id: ir.part_id });
  }

  const created = optNum(r.created_at) ?? Date.now();
  return {
    id,
    owner,
    name: typeof r.name === 'string' && r.name ? r.name : id,
    created_at: created,
    updated_at: optNum(r.updated_at),
    subtotal: Math.max(0, Math.round(num(r.subtotal, 0))),
    commission: Math.max(0, Math.round(num(r.commission, 0))),
    total_price: Math.max(0, Math.round(num(r.total_price, num(r.subtotal, 0)))),
    rating: optNum(r.rating),
    is_public: r.is_public === undefined ? true : Boolean(r.is_public),
    parts,
  };
}

/** Разбор parts.json (строгий массив или { parts: [...] } или { data: [...] }). */
export function parsePartsJson(raw: unknown): PartRow[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root.parts ?? root.data ?? root.items);
  const out: PartRow[] = [];
  for (const item of list) {
    const row = normalizePartRow(item);
    if (row) out.push(row);
  }
  return out;
}

/** Разбор builds.json (строгий массив или { builds: [...] } или { data: [...] }). */
export function parseBuildsJson(raw: unknown): BuildDoc[] {
  const root = asRecord(raw);
  const list = Array.isArray(raw) ? raw : asArray(root.builds ?? root.data ?? root.items);
  const out: BuildDoc[] = [];
  for (const item of list) {
    const row = normalizeBuildDoc(item);
    if (row) out.push(row);
  }
  return out;
}

/** Сериализация каталога деталей в документ parts.json. */
export function serializePartsJson(parts: readonly PartRow[] = PARTS_SEED) {
  return { version: MARKET_SCHEMA_VERSION, parts };
}

/** Сериализация сборок в документ builds.json (со вложенными слотами). */
export function serializeBuildsJson(
  builds: readonly BuildRow[] = BUILDS_SEED,
  items: readonly BuildItemRow[] = BUILD_ITEMS_SEED,
) {
  const byBuild = new Map<string, BuildItemRef[]>();
  for (const it of items) {
    const list = byBuild.get(it.build_id) ?? [];
    list.push({ slot: it.slot, part_id: it.part_id });
    byBuild.set(it.build_id, list);
  }
  const docs: BuildDoc[] = builds.map((b) => ({ ...b, parts: byBuild.get(b.id) ?? [] }));
  return { version: MARKET_SCHEMA_VERSION, builds: docs };
}

/** Разворачивание вложенных слотов обратно в строки таблицы build_items. */
export function flattenBuildItems(builds: readonly BuildDoc[]): BuildItemRow[] {
  const out: BuildItemRow[] = [];
  for (const b of builds) {
    for (const p of b.parts) out.push({ build_id: b.id, slot: p.slot, part_id: p.part_id });
  }
  return out;
}

/** Индекс деталей по id — для валидации сборок и расчёта цены. */
export function indexPartsById(parts: readonly PartRow[]): Map<string, PartRow> {
  return new Map(parts.map((p) => [p.id, p]));
}

/** Проверка ссылочной целостности документа сборки против каталога. */
export function validateBuildDoc(build: BuildDoc, partsById: Map<string, PartRow>): string[] {
  const problems: string[] = [];
  const slots = new Set<string>();
  for (const item of build.parts) {
    if (slots.has(item.slot)) problems.push(`${build.id}: duplicate slot ${item.slot}`);
    slots.add(item.slot);
    const part = partsById.get(item.part_id);
    if (!part) {
      problems.push(`${build.id}: missing part ${item.part_id}`);
    } else if (part.category !== item.slot) {
      problems.push(`${build.id}: part ${item.part_id} category ${part.category} != slot ${item.slot}`);
    }
  }
  return problems;
}

/** Полная проверка документа маркетплейса (parts.json + builds.json). */
export function validateMarketDocument(
  partsDoc: unknown,
  buildsDoc: unknown,
): { parts: PartRow[]; builds: BuildDoc[]; problems: string[] } {
  const parts = parsePartsJson(partsDoc);
  const builds = parseBuildsJson(buildsDoc);
  const partsById = indexPartsById(parts);
  const problems = [...validateMarketSchema()];

  const seenParts = new Set<string>();
  for (const p of parts) {
    if (seenParts.has(p.id)) problems.push(`duplicate part id: ${p.id}`);
    seenParts.add(p.id);
  }
  for (const b of builds) problems.push(...validateBuildDoc(b, partsById));

  return { parts, builds, problems };
}

/* -------------------------------------------------------------------------- */
/*  8. 3D-табло схемы (R3F)                                                   */
/* -------------------------------------------------------------------------- */

const PANEL_BG = '#0b1220';
const PANEL_EDGE = '#1e293b';
const ACCENT = '#38bdf8';
const ACCENT_2 = '#f59e0b';
const DIM = '#94a3b8';

export interface MarketSchemaBoardProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

/**
 * Наглядное табло схемы БД маркетплейса: две карточки `parts` и `builds`,
 * счётчики колонок/индексов и ставка комиссии. Легко вешается на стену
 * павильона тюнинга (TuningMarket.tsx).
 */
export function MarketSchemaBoard({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = 1,
}: MarketSchemaBoardProps) {
  const group = useRef<THREE.Group>(null);
  const stats = useMemo(() => marketSchemaStats(), []);

  useFrame((state) => {
    if (!group.current) return;
    group.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.3) * 0.06;
  });

  const partsTable = MARKET_TABLES[0];
  const buildsTable = MARKET_TABLES[1];
  const lines = [
    { text: `MARKET DB  v${MARKET_SCHEMA_VERSION}`, color: ACCENT, size: 0.34, y: 1.35 },
    { text: `tables=${stats.tables}  cols=${stats.columns}  idx=${stats.indexes}`, color: DIM, size: 0.2, y: 1.0 },
    { text: `parts  → ${partsTable.columns.length} cols`, color: '#e2e8f0', size: 0.26, y: 0.55 },
    { text: `builds → ${buildsTable.columns.length} cols`, color: '#e2e8f0', size: 0.26, y: 0.2 },
    { text: `build_items → ${MARKET_TABLES[2].columns.length} cols`, color: '#e2e8f0', size: 0.22, y: -0.15 },
    {
      text: `commission ${(MARKET_COMMISSION_RATE * 100).toFixed(0)}%  (backend)`,
      color: ACCENT_2,
      size: 0.22,
      y: -0.55,
    },
  ];

  return (
    <group ref={group} position={position} rotation={rotation} scale={scale}>
      <mesh position={[0, 0.4, -0.02]}>
        <planeGeometry args={[5.4, 3.2]} />
        <meshStandardMaterial color={PANEL_BG} metalness={0.2} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.4, -0.01]}>
        <planeGeometry args={[5.6, 3.4]} />
        <meshBasicMaterial color={PANEL_EDGE} wireframe />
      </mesh>
      {lines.map((l) => (
        <Text
          key={l.text}
          position={[0, l.y, 0.01]}
          color={l.color}
          fontSize={l.size}
          anchorX="center"
          anchorY="middle"
        >
          {l.text}
        </Text>
      ))}
    </group>
  );
}

export default MarketSchemaBoard;
