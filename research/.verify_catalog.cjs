// Verifies the money/rating formulas published in research/catalog.md.
const assert = require('node:assert');

// ---- §3.2 commission split (30.00%) ----
const FEE_BPS = 3000;
const calcFee = (gross) => Math.floor((gross * FEE_BPS) / 10000);
const split = (gross) => {
  const fee = calcFee(gross);
  return { gross, fee, net: gross - fee };
};

const cases = [1, 15, 100, 999, 4900, 1000000];
for (const g of cases) {
  const s = split(g);
  assert.strictEqual(s.fee + s.net, s.gross, `invariant broken for gross=${g}`);
  assert.ok(s.net >= 0);
}
console.log('commission invariant ok for', cases.join(', '));
console.log('  4900c ->', JSON.stringify(split(4900)), '(expect fee=1470 net=3430)');
assert.deepStrictEqual(split(4900), { gross: 4900, fee: 1470, net: 3430 });
assert.deepStrictEqual(split(999),  { gross: 999,  fee: 299,  net: 700  });
assert.deepStrictEqual(split(1),    { gross: 1,    fee: 0,    net: 1    });
assert.deepStrictEqual(split(100),  { gross: 100,  fee: 30,   net: 70   });
console.log('commission examples ok');

// ---- §4.3 Bayesian rating ----
const C = 20, m = 4.0;
const bayes = (n, sum) => (C * m + sum) / (C + n);
const A = bayes(1, 5);     // (80+5)/21  = 4.05
const B = bayes(500, 2350);// (80+2350)/520 = 4.67
const Cc = bayes(3, 3);    // (80+3)/23  = 3.61
console.log('bayes A(1 review, 5*)   =', A.toFixed(2), '(expect 4.05)');
console.log('bayes B(500, avg 4.7)   =', B.toFixed(2), '(expect 4.67)');
console.log('bayes C(3, avg 1.0)     =', Cc.toFixed(2), '(expect 3.61)');
assert.ok(A < B, 'weak-sample A must rank below B');
assert.ok(Cc < A, 'bad C must rank below A');
// doc publishes the 2-decimal display value (85/21 = 4.0476 -> "4.05")
assert.strictEqual(A.toFixed(2), '4.05');
assert.strictEqual(B.toFixed(2), '4.67');
assert.strictEqual(Cc.toFixed(2), '3.61');

// ---- ledger double-entry balance on a 4900c order ----
const fee = calcFee(4900), net = 4900 - fee;
let debits = 0, credits = 0;
// §3.5 postings: buyer D4900 / escrow C4900 ; escrow D4900 / seller C3430 / platform C1470
for (const [d, c] of [[4900,0],[0,4900],[4900,0],[0,3430],[0,1470]]) { debits += d; credits += c; }
console.log('ledger debits =', debits, 'credits =', credits, '(balanced:', debits === credits, ')');
assert.strictEqual(debits, credits);

console.log('ALL CATALOG.md EXAMPLES OK');
