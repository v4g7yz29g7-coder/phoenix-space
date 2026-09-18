'use strict';
const { detectDrama } = require('./drama_detector.js');
const now = Date.now();
const state = {
  timestamp: now,
  cars: [
    { id: 'VER', position: 1, lap: 12, speed: 210, ok: true, gapToAhead: 0 },
    { id: 'HAM', position: 2, lap: 12, speed: 205, ok: true, gapToAhead: 3.2 },
    { id: 'LEC', position: 3, lap: 12, speed: 0, ok: true, stuckFor: 75 },
    { id: 'NOR', position: 4, lap: 12, speed: 180, ok: false, gapToAhead: 1.1 },
    { id: 'SAI', position: 5, lap: 12, speed: 175, ok: true, gapToAhead: 2.5 }
  ],
  previous: { cars: [
    { id: 'VER', position: 1, lap: 11, gapToAhead: 0 },
    { id: 'HAM', position: 2, lap: 11, gapToAhead: 5.0 },
    { id: 'LEC', position: 3, lap: 11, gapToAhead: 1.0 },
    { id: 'NOR', position: 4, lap: 11, gapToAhead: 2.5 },
    { id: 'SAI', position: 5, lap: 11, gapToAhead: 1.5 }
  ]}
};
const res = detectDrama(state);
console.log(JSON.stringify(res, null, 2));
const types = new Set(res.map(e => e.type));
['gap','stuck','incident','closing'].forEach(t => console.log(t, types.has(t) ? 'OK' : 'MISSING'));
console.log('empty:', JSON.stringify(detectDrama(null)));
console.log('junk:', JSON.stringify(detectDrama({ cars: [{}, 'x', null] })));
