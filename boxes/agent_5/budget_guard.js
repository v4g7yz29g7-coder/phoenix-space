const fs = require('fs');
const path = require('path');
const SPEND_FILE = path.resolve(__dirname, '../../memory/daily_spend.json');
const DAILY_LIMIT = parseFloat(process.env.DAILY_BUDGET_USD || '2.00');
const PRICE_INPUT_PER_M  = 0.14;
const PRICE_OUTPUT_PER_M = 0.28;
function today() { return new Date().toISOString().slice(0, 10); }
function readSpend() {
  try {
    const d = JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
    if (d.date !== today()) return { date: today(), spent_usd: 0 };
    return d;
  } catch (e) { return { date: today(), spent_usd: 0 }; }
}
function writeSpend(d) {
  try {
    fs.mkdirSync(path.dirname(SPEND_FILE), { recursive: true });
    fs.writeFileSync(SPEND_FILE, JSON.stringify(d, null, 2));
  } catch (e) {}
}
function checkBudget() {
  const d = readSpend();
  if (d.spent_usd >= DAILY_LIMIT) {
    return { ok: false, reason: 'daily_budget_exceeded', spent: d.spent_usd, limit: DAILY_LIMIT };
  }
  return { ok: true, spent: d.spent_usd, limit: DAILY_LIMIT };
}
function recordUsage(inputTokens, outputTokens) {
  const d = readSpend();
  const cost = (inputTokens  / 1_000_000) * PRICE_INPUT_PER_M
             + (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  d.spent_usd = (d.spent_usd || 0) + cost;
  d.date = today();
  writeSpend(d);
  return d.spent_usd;
}
module.exports = { checkBudget, recordUsage, readSpend, DAILY_LIMIT };
