'use strict';

/**
 * PID-регулятор критичности (SOC).
 *
 * Цель: удерживать load на уровне SETPOINT (2.0).
 *   - load > THROTTLE_HIGH (3.0) -> throttle = 1 (гасим активность)
 *   - load < BOOST_LOW    (1.5) -> boost    = 1 (поднимаем активность)
 * Внутри «мёртвой зоны» величина throttle/boost считается PID-контуром
 * (пропорциональная + интегральная + дифференциальная составляющие).
 *
 * API: regulate(load) -> { throttle, boost }
 */

const DEFAULTS = {
  setpoint: 2.0, // целевая нагрузка
  kp: 0.6, // пропорциональный коэффициент
  ki: 0.15, // интегральный коэффициент
  kd: 0.05, // дифференциальный коэффициент
  throttleHigh: 3.0, // порог жёсткого throttle
  boostLow: 1.5, // порог жёсткого boost
  dt: 1, // шаг дискретизации
  integralMin: -10, // анти-виндап
  integralMax: 10
};

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Создаёт изолированный экземпляр PID-регулятора (со своим интегратором).
 */
function createRegulator(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options);
  let integral = 0;
  let prevError = 0;
  let first = true;

  /**
   * @param {number} load текущая нагрузка
   * @returns {{throttle:number, boost:number}}
   */
  function regulate(load) {
    const value = Number(load);
    if (!Number.isFinite(value)) {
      throw new TypeError('regulate(load): load должен быть числом');
    }

    if (value > cfg.throttleHigh) {
      // жёсткий сброс активности поверх PID; сбрасываем интегратор,
      // чтобы при возврате к сетпоинту не было ложного throttle из-за виндапа
      integral = 0;
      prevError = cfg.setpoint - value;
      first = false;
      return { throttle: 1, boost: 0 };
    }

    if (value < cfg.boostLow) {
      // жёсткий разгон активности поверх PID; сбрасываем интегратор,
      // чтобы при возврате к сетпоинту не было ложного boost из-за виндапа
      integral = 0;
      prevError = cfg.setpoint - value;
      first = false;
      return { throttle: 0, boost: 1 };
    }

    // error > 0 -> нагрузка ниже цели -> нужен boost
    // error < 0 -> нагрузка выше цели -> нужен throttle
    const error = cfg.setpoint - value;

    integral += error * cfg.dt;
    integral = clamp(integral, cfg.integralMin, cfg.integralMax);

    const derivative = first ? 0 : (error - prevError) / cfg.dt;
    first = false;
    prevError = error;

    const output = clamp(cfg.kp * error + cfg.ki * integral + cfg.kd * derivative, -1, 1);

    return {
      throttle: output < 0 ? -output : 0,
      boost: output > 0 ? output : 0
    };
  }

  function reset() {
    integral = 0;
    prevError = 0;
    first = true;
  }

  return { regulate, reset, config: cfg };
}

// Синглтон с настройками по умолчанию — совместим с API regulate(load).
const _default = createRegulator();

module.exports = {
  regulate: _default.regulate,
  reset: _default.reset,
  createRegulator,
  DEFAULTS
};
