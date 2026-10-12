// Finds receipts whose printed Previous Balance is lower than it should be, and
// with --apply raises it. Dry run by default: it only lists what it would do.
//
//   node scripts/repair-previous-due.js            # list, change nothing
//   node scripts/repair-previous-due.js --apply    # write the fixes
//
// Uses DATABASE_URL / DATABASE_AUTH_TOKEN like server.js (local shop.db when
// unset), so point it at Turso the same way the server is.
//
// How a receipt gets a wrong one: it was saved without the customer's phone,
// so the sale found none of their dues and stored previous_due = 0, and the
// phone was added later through Edit receipt — which before this fix kept the
// stale 0. (Invoice #221, 10-10-2026, was the case that showed it.)
//
// What counts as wrong: a receipt's earlier receipts for the same customer
// still owe more today than the previous_due it stored. Dues only fall over
// time — payments raise paid_amount — so whatever they owe today they owed at
// least that much on the day, and the receipt should have printed at least
// that. It is raised to exactly that figure: a lower bound, never a guess.
// Receipts from before running balances (previous_due NULL) are left alone.
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apply = process.argv.includes('--apply');
const db = createClient({
  url: process.env.DATABASE_URL || `file:${path.join(root, 'shop.db')}`,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

const round2 = (n) => Math.round(n * 100) / 100;
const EPSILON = 0.005;

// The same money as MONEY_SQL / moneyOf() in server.js.
const { rows } = await db.execute(`
  SELECT v.id, v.date, v.customer_name, v.customer_contact, v.paid_amount, v.discount, v.previous_due,
         (SELECT COALESCE(SUM(total_price), 0) FROM sales WHERE invoice_id = v.id) AS gross,
         (SELECT COALESCE(SUM(rl.amount), 0) FROM return_lines rl JOIN returns r ON r.id = rl.return_id
           WHERE r.invoice_id = v.id) AS back,
         (SELECT COALESCE(SUM(refund_amount), 0) FROM returns WHERE invoice_id = v.id) AS refunded
    FROM invoices v ORDER BY v.id`);

const invoices = rows.map((r) => {
  const gross = Number(r.gross);
  const discount = Number(r.discount || 0);
  const net = Math.max(0, gross - Number(r.back) - discount);
  const paidIn = r.paid_amount == null ? gross - discount : Number(r.paid_amount);
  const contact = String(r.customer_contact ?? '').trim();
  const name = String(r.customer_name ?? '').trim();
  return {
    id: Number(r.id),
    date: r.date,
    name,
    contact,
    // customerKey() in server.js: phone, else name, else a walk-in (no history).
    key: contact ? `c:${contact}` : name ? `n:${name.toLowerCase()}` : null,
    previousDue: r.previous_due == null ? null : Number(r.previous_due),
    due: Math.max(0, round2(net - (paidIn - Number(r.refunded)))),
  };
});

const fixes = [];
for (const inv of invoices) {
  if (inv.previousDue === null || !inv.key) continue;
  const owedBefore = round2(
    invoices.filter((e) => e.id < inv.id && e.key === inv.key).reduce((sum, e) => sum + e.due, 0)
  );
  if (owedBefore > inv.previousDue + EPSILON) fixes.push({ ...inv, owedBefore });
}

console.log(`${invoices.length} receipts checked.`);
if (!fixes.length) {
  console.log('Every Previous Balance is right. Nothing to do.');
  process.exit(0);
}
for (const f of fixes) {
  console.log(
    `  #${f.id}  ${f.date}  ${f.name || '(no name)'}  ${f.contact || '(no phone)'}  ` +
      `Previous Balance ${f.previousDue.toFixed(2)} → ${f.owedBefore.toFixed(2)}`
  );
}
if (!apply) {
  console.log(`\nDry run — nothing changed. Run again with --apply to fix ${fixes.length} receipt(s).`);
  process.exit(0);
}

await db.batch(
  fixes.map((f) => ({ sql: 'UPDATE invoices SET previous_due = ? WHERE id = ?', args: [f.owedBefore, f.id] })),
  'write'
);
console.log(`\nFixed ${fixes.length} receipt(s).`);
