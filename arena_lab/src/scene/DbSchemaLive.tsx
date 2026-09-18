/**
 * ЗАДАЧА 6.2 — СХЕМА БД · LIVE-ИНСПЕКТОР (companion к DbSchema.tsx)
 * ============================================================================
 * DbSchema.tsx владеет реестром (`DB_SCHEMA`) и генератором SQL. Этот файл —
 * тонкая 2D-надстройка инженера БД: живая сводка + DDL + отчёт целостности +
 * план миграций flat-JSON -> SQL. Ничего не дублирует: всё берётся из экспортов
 * `./DbSchema`, поэтому схема остаётся единственным источником правды.
 *
 * Зачем отдельный файл: 3D-стела (`DbSchemaBoard`) видна только внутри <Canvas>,
 * а инженеру/бэкенду нужен читаемый DDL прямо на экране (в т.ч. для копирования
 * в миграции `web/server.js`). Панель чисто презентационная, без three/R3F,
 * поэтому её можно монтировать вне Canvas и рендерить в SSR/тестах.
 *
 * Совет Оракула: секреты (salt/hash) помечены в реестре `secret` и в DDL-панели
 * выделены отдельно — их нельзя выносить в публичные проекции (`PILOT_PUBLIC_COLUMNS`).
 *
 * Reference: arena_lab/src/scene/DbSchema.tsx, web/server.js, research/db.md.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  DB_SCHEMA,
  DB_SCHEMA_VERSION,
  MIGRATION_PLAN,
  PILOT_PUBLIC_COLUMNS,
  createSchemaSql,
  schemaStats,
  validateSchema,
  publicColumns,
} from './DbSchema';
import type { SqlDialect, TableSpec } from './DbSchema';

export interface DbSchemaLiveProps {
  /** Стартовый диалект для показа DDL. */
  dialect?: SqlDialect;
  /** Колбэк закрытия панели (кнопка ✕). */
  onClose?: () => void;
}

function tableBadges(t: TableSpec): string[] {
  const badges: string[] = [];
  const pks = t.columns.filter((c) => c.pk).map((c) => c.name);
  const fks = t.columns.filter((c) => !!c.ref);
  const secrets = t.columns.filter((c) => !!c.secret).map((c) => c.name);
  if (pks.length) badges.push(`PK ${pks.join('+')}`);
  if (fks.length) badges.push(`FK×${fks.length}`);
  if (t.indexes?.length) badges.push(`IDX×${t.indexes.length}`);
  if (secrets.length) badges.push(`SECRET ${secrets.join(',')}`);
  return badges;
}

/** Живой инспектор реестра схемы: сводка, DDL, целостность, план миграций. */
export function DbSchemaLive({ dialect: initialDialect = 'sqlite', onClose }: DbSchemaLiveProps) {
  const [dialect, setDialect] = useState<SqlDialect>(initialDialect);

  const problems = useMemo(() => validateSchema(DB_SCHEMA), []);
  const stats = useMemo(() => schemaStats(DB_SCHEMA), []);
  const ddl = useMemo(() => createSchemaSql(dialect), [dialect]);
  const healthy = problems.length === 0;

  return (
    <div style={panel} data-testid="db-schema-live">
      <div style={header}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#38bdf8', letterSpacing: 1 }}>
            🗄 DB SCHEMA v{DB_SCHEMA_VERSION}
          </div>
          <div style={{ fontSize: 11, color: healthy ? '#22c55e' : '#ef4444', marginTop: 2 }}>
            {healthy ? '● INTEGRITY OK' : `● PROBLEMS: ${problems.length}`}
            {' · '}
            {stats.tables} tables · {stats.columns} cols · {stats.foreignKeys} FK · {stats.indexes} idx ·{' '}
            <span style={{ color: '#f59e0b' }}>{stats.secrets} secret</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            style={tabBtn(dialect === 'sqlite')}
            onClick={() => setDialect('sqlite')}
            type="button"
          >
            sqlite
          </button>
          <button
            style={tabBtn(dialect === 'postgres')}
            onClick={() => setDialect('postgres')}
            type="button"
          >
            postgres
          </button>
          {onClose && (
            <button style={closeBtn} onClick={onClose} type="button" aria-label="close">
              ✕
            </button>
          )}
        </div>
      </div>

      {!healthy && (
        <ul style={problemsList}>
          {problems.slice(0, 5).map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div style={grid}>
        <div>
          <div style={sectionTitle}>TABLES</div>
          <div style={scroll}>
            {DB_SCHEMA.map((t) => (
              <div key={t.name} style={tableRow}>
                <div style={tableName}>{t.name}</div>
                <div style={tableComment}>{t.comment}</div>
                <div style={badgeWrap}>
                  {tableBadges(t).map((b) => (
                    <span key={b} style={badge(b.startsWith('SECRET'))}>
                      {b}
                    </span>
                  ))}
                </div>
                <div style={colList}>
                  {publicColumns(t)
                    .map((c) => `${c.name}:${c.type}`)
                    .join('  ')}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={sectionTitle}>DDL · {dialect}</div>
          <pre style={pre}>{ddl}</pre>

          <div style={sectionTitle}>MIGRATIONS</div>
          <div style={scrollShort}>
            {MIGRATION_PLAN.map((m) => (
              <div key={m.version} style={migrationRow}>
                <span style={{ color: '#a855f7' }}>v{m.version}</span>
                <span style={{ color: '#7a8baa' }}>{m.from}</span>
                <span style={{ color: '#4dd0ff' }}>→ {m.to}</span>
                <span style={{ color: '#6eff8b' }}>{m.mapper}()</span>
              </div>
            ))}
          </div>

          <div style={sectionTitle}>PUBLIC PILOT COLUMNS</div>
          <div style={{ fontSize: 11, color: '#cbd5e1', fontFamily: 'monospace' }}>
            {PILOT_PUBLIC_COLUMNS.join(', ')}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DbSchemaLive;

/* -------------------------------------------------------------------------- */
/*  Стили (инлайн, без зависимостей)                                          */
/* -------------------------------------------------------------------------- */

const panel: CSSProperties = {
  position: 'absolute',
  top: 80,
  right: 24,
  width: 620,
  maxWidth: '92vw',
  maxHeight: 'calc(100vh - 120px)',
  overflow: 'hidden',
  background: 'rgba(11,18,32,0.96)',
  border: '1px solid #1e3a5f',
  borderRadius: 10,
  padding: 12,
  zIndex: 30,
  pointerEvents: 'auto',
  color: '#e0e6f0',
  boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
};

const header: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  borderBottom: '1px solid #1e3a5f',
  paddingBottom: 8,
  marginBottom: 8,
};

const tabBtn = (active: boolean): CSSProperties => ({
  background: active ? '#38bdf8' : 'transparent',
  color: active ? '#0b1220' : '#94a3b8',
  border: '1px solid #38bdf8',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 700,
  padding: '3px 8px',
  cursor: 'pointer',
});

const closeBtn: CSSProperties = {
  background: 'transparent',
  color: '#94a3b8',
  border: '1px solid #334155',
  borderRadius: 6,
  fontSize: 12,
  padding: '3px 8px',
  cursor: 'pointer',
};

const problemsList: CSSProperties = {
  margin: '0 0 8px 0',
  padding: '6px 8px 6px 22px',
  background: 'rgba(239,68,68,0.12)',
  border: '1px solid rgba(239,68,68,0.4)',
  borderRadius: 6,
  fontSize: 11,
  color: '#fca5a5',
  maxHeight: 90,
  overflow: 'auto',
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
};

const sectionTitle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1.5,
  color: '#7a8baa',
  margin: '4px 0 6px',
  textTransform: 'uppercase',
};

const scroll: CSSProperties = {
  maxHeight: 340,
  overflow: 'auto',
  paddingRight: 4,
};

const scrollShort: CSSProperties = {
  maxHeight: 110,
  overflow: 'auto',
};

const tableRow: CSSProperties = {
  borderBottom: '1px solid #16233a',
  padding: '6px 0',
};

const tableName: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: '#38bdf8',
  fontFamily: 'monospace',
};

const tableComment: CSSProperties = {
  fontSize: 10,
  color: '#7a8baa',
  margin: '2px 0',
};

const badgeWrap: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  margin: '2px 0',
};

const badge = (secret: boolean): CSSProperties => ({
  fontSize: 9,
  padding: '1px 5px',
  borderRadius: 4,
  background: secret ? 'rgba(245,158,11,0.15)' : 'rgba(56,189,248,0.12)',
  color: secret ? '#fbbf24' : '#7dd3fc',
  border: `1px solid ${secret ? 'rgba(245,158,11,0.4)' : 'rgba(56,189,248,0.3)'}`,
  fontFamily: 'monospace',
});

const colList: CSSProperties = {
  fontSize: 10,
  color: '#64748b',
  fontFamily: 'monospace',
  lineHeight: 1.5,
  wordBreak: 'break-word',
};

const pre: CSSProperties = {
  margin: 0,
  padding: 8,
  background: '#060b14',
  border: '1px solid #16233a',
  borderRadius: 6,
  fontSize: 10,
  lineHeight: 1.5,
  color: '#bae6fd',
  maxHeight: 300,
  overflow: 'auto',
  whiteSpace: 'pre',
};

const migrationRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  fontSize: 10,
  fontFamily: 'monospace',
  padding: '2px 0',
  flexWrap: 'wrap',
};
