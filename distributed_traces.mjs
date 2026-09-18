// ESM-обёртка над CommonJS-модулем distributed_traces.js.
// Позволяет импортировать namespaced-имена в ESM-окружении.
import mod from './distributed_traces.js';

export const { startSpan, endSpan, buildTree, criticalPath } = mod;
export const { getSpan, reset, selfTest } = mod;
export default mod;
