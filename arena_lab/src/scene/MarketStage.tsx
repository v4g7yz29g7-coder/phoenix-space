/**
 * ЗАДАЧА 7.2 — API /parts, /builds · СЦЕНА-ОБВЯЗКА МАРКЕТПЛЕЙСА (FORMULA I1)
 * ============================================================================
 * Платформа. Мост между бэкендом (`MarketServer.tsx`) и павильоном
 * (`TuningMarket.tsx`): устанавливает in-browser сервер `/api/parts` и
 * `/api/builds`, поднимает павильон на пит-лейне и показывает экономику
 * покупки — комиссию платформы 30%, рассчитанную НА СЕРВЕРЕ (`priceBuild`).
 *
 * Зачем отдельный файл:
 *   • `TuningMarket.tsx` (7.2) не был смонтирован в сцене — павильон
 *     существовал только в коде; здесь он появляется на арене;
 *   • единая точка установки mock-сервера — до первого эффекта павильона,
 *     чтобы `loadParts()/loadBuilds()` отвечали реальными данными, а не
 *     уходили в offline-фолбэк.
 *
 * Приёмы из research/racing-game (MIT):
 *   - src/ui/Speed/Gauge.tsx — LED-цифры из примитивов (здесь HUD экономики);
 *   - src/ui/LeaderBoard.tsx — акценты по рангу сборок на витрине.
 * Код собственный, в терминах проекта AI-1.
 * ============================================================================
 */

import { useEffect } from 'react';
import { Html } from '@react-three/drei';
import { TuningMarket, useMarketStore, MARKET_API_BASE } from './TuningMarket';
import {
  COMMISSION_RATE,
  installMarketServer,
  priceBuild,
} from './MarketServer';

/* Устанавливаем mock-сервер синхронно на импорте модуля: гарантирует, что
 * fetch-перехватчик активен раньше, чем сработают эффекты павильона. */
installMarketServer();

/* -------------------------------------------------------------------------- */
/*  Экономический HUD                                                         */
/* -------------------------------------------------------------------------- */

function EconomicsHud() {
  const parts = useMarketStore((s) => s.parts);
  const builds = useMarketStore((s) => s.builds);
  const error = useMarketStore((s) => s.error);

  const sample = builds[0];
  const pricing = sample ? priceBuild({ name: sample.name, parts: sample.parts }, parts) : null;
  const rate = `${Math.round(COMMISSION_RATE * 100)}%`;

  return (
    <Html
      position={[1.6, 5.4, -1.3]}
      transform
      sprite={false}
      distanceFactor={12}
      style={{ pointerEvents: 'none' }}
    >
      <div
        style={{
          width: 300,
          padding: '10px 12px',
          borderRadius: 10,
          background: 'rgba(7, 11, 22, 0.92)',
          border: '1px solid #1d2b45',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          color: '#eaf3ff',
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: 1, color: '#8fe3ff', marginBottom: 6 }}>
          MARKET API · {MARKET_API_BASE}/parts · /builds
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: '#7a8baa' }}>ДЕТАЛЕЙ</span>
          <span>{parts.length}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: '#7a8baa' }}>СБОРОК</span>
          <span>{builds.length}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: '#7a8baa' }}>КОМИССИЯ ПЛАТФОРМЫ</span>
          <span style={{ color: '#ffd700' }}>{rate}</span>
        </div>
        {pricing && (
          <>
            <div style={{ height: 1, background: '#1d2b45', margin: '6px 0' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: '#7a8baa' }}>ЦЕНА СБОРКИ</span>
              <span>{pricing.price} ⧫</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: '#7a8baa' }}>− {rate} КОМИССИЯ</span>
              <span style={{ color: '#ff5c5c' }}>{pricing.commission} ⧫</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: '#7a8baa' }}>К ВЫПЛАТЕ</span>
              <span style={{ color: '#6eff8b' }}>{pricing.payout} ⧫</span>
            </div>
          </>
        )}
        {error && (
          <div style={{ marginTop: 6, fontSize: 10, color: '#ff9f43' }}>offline: {error}</div>
        )}
      </div>
    </Html>
  );
}

/* -------------------------------------------------------------------------- */
/*  Сцена маркетплейса                                                        */
/* -------------------------------------------------------------------------- */

export interface MarketStageProps {
  /** Смещение павильона в мире (по умолчанию — собственный MARKET_POSITION). */
  position?: [number, number, number];
  /** Показывать ли экономический HUD. */
  showHud?: boolean;
}

/**
 * Полная сцена маркетплейса: mock-сервер + павильон `TuningMarket` + HUD.
 * Монтируется в общий `<Canvas>` арены.
 */
export function MarketStage({ position, showHud = true }: MarketStageProps) {
  // Идемпотентно: повторный вызов после hot-reload безопасен.
  useEffect(() => {
    installMarketServer();
  }, []);

  return (
    <group position={position ?? [0, 0, 0]}>
      <TuningMarket />
      {showHud && <EconomicsHud />}
    </group>
  );
}

export default MarketStage;
