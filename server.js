import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@libsql/client';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Override with PORT=… to run a second instance (a test copy, say) alongside
// the one the shop is using.
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------------------
   Database — libSQL.

   One driver covers both deployments, because @libsql/client speaks the same
   SQLite dialect over a local file and over the network:

     no DATABASE_URL  ->  file:shop.db next to this file, exactly as before
     DATABASE_URL set ->  a hosted Turso database (libsql://…)

   The path is resolved against this file, not the working directory —
   otherwise starting the server from elsewhere silently creates a second,
   empty database.
   --------------------------------------------------------------------------- */
const DATABASE_URL = process.env.DATABASE_URL || `file:${path.join(__dirname, 'shop.db')}`;
const isRemote = !DATABASE_URL.startsWith('file:');

/* createClient throws synchronously if it cannot open a local file, which on a
   hosted platform means the module fails at import and the platform reports an
   opaque crash. The most likely cause by far is deploying before DATABASE_URL
   is set: the app falls back to a local file, and a serverless filesystem is
   read-only. Say that plainly rather than leaving a libSQL stack trace as the
   only clue. */
let db;
try {
  db = createClient({
    url: DATABASE_URL,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
} catch (err) {
  console.error('\n=== NetBazar could not open its database ===');
  if (isRemote) {
    console.error('DATABASE_URL is set, so check it and DATABASE_AUTH_TOKEN are correct.');
  } else {
    console.error(
      (process.env.DATABASE_URL
        ? 'DATABASE_URL points at a local file, and that file is not writable.\n'
        : 'DATABASE_URL is not set, so the app fell back to a local file — and this\n' +
          'filesystem is not writable.\n') +
        'If this is a hosted deployment, set DATABASE_URL and DATABASE_AUTH_TOKEN to\n' +
        'your Turso database and redeploy. See DEPLOY.md.'
    );
  }
  console.error(`Tried: ${DATABASE_URL}`);
  console.error(`Underlying error: ${err.message}\n`);
  process.exit(1);
}

console.log(isRemote ? 'Connected to the hosted database.' : 'Connected to the local SQLite file.');

/* Promise wrappers.

   These keep the shape the routes were written against — `run` returning
   { lastID, changes }, `get` a single row, `all` an array — so swapping the
   driver did not ripple through every call site.

   One sharp edge worth the conversion: libSQL returns lastInsertRowid as a
   BigInt, and JSON.stringify throws outright on BigInt. Returning it raw would
   have made every successful insert respond with a 500. */
const run = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return {
    lastID: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid),
    changes: r.rowsAffected,
  };
};

const get = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows[0];
};

const all = async (sql, args = []) => {
  const r = await db.execute({ sql, args });
  return r.rows;
};

/* The shop's wall-clock time as HH:MM, 24-hour — the format fmtTime() on the
   client already parses, and what every existing row uses.

   The timezone is named explicitly rather than read from the process, because
   the process timezone cannot be relied on: Vercel runs functions in UTC and
   treats TZ as a reserved variable that cannot be set. Date#getHours() there
   would stamp a 12:53am sale as 6:53pm the previous evening.

   Intl carries its own timezone database, so this is correct wherever the
   server happens to run — the shop PC, a Vercel function, anywhere. Override
   with SHOP_TIMEZONE if the shop ever moves. */
const SHOP_TIMEZONE = process.env.SHOP_TIMEZONE || 'Asia/Dhaka';

function nowLocalTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: SHOP_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  // en-GB renders midnight as 24 in some ICU versions; normalise it to 00.
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${hour}:${part('minute')}`;
}

// The shop's calendar date as YYYY-MM-DD, same reasoning. en-CA formats in that
// order natively, so there is nothing to reassemble.
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Adds a column to an existing table when it is not there yet. SQLite has no
// ADD COLUMN IF NOT EXISTS, so the current shape is read first.
//
// Note the constraints this operates under: ADD COLUMN cannot add a NOT NULL
// column without a constant default, and cannot add UNIQUE at all (see the
// barcode index in migrate()). `table`/`column`/`definition` are interpolated,
// so every caller must stay hardcoded — never pass user input.
async function addColumnIfMissing(table, column, definition) {
  const columns = await all(`PRAGMA table_info(${table})`);
  if (columns.some((c) => c.name === column)) return false;
  try {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    // On serverless, two cold instances can both read the old shape and both
    // try the ALTER; the loser gets "duplicate column name". The column exists
    // either way, so that is success, not a reason to refuse every request.
    if (/duplicate column name/i.test(err.message)) return false;
    throw err;
  }
  console.log(`Migrated: added ${table}.${column}`);
  return true;
}

/* Schema changes for existing databases, applied in order.

   The ordering is not cosmetic: the barcode index references inventory.barcode,
   so it must be issued strictly *after* that ALTER has completed. The previous
   callback version issued its ALTER from inside a PRAGMA callback — i.e. after
   the enclosing serialize() window had already closed — so an index created
   alongside it would fail with "no such column: barcode". Being IF NOT EXISTS
   with a logged-and-swallowed error, that failure would be silent, and
   duplicate barcodes would quietly become possible weeks later. */
async function migrate() {
  await addColumnIfMissing('sales', 'customer_contact', 'TEXT');
  await addColumnIfMissing('sales', 'sale_time', 'TEXT');

  // Nullable on purpose: NULL means "recorded before warranties existed, or the
  // item was not in inventory", while 0 means "known product, no warranty".
  // Both print nothing, but the distinction is worth keeping in the data.
  await addColumnIfMissing('sales', 'warranty_months', 'INTEGER');

  /* Profit snapshots, both taken from the product at the moment of sale.

     cost_price is what makes profit history stable: restocking a product at a
     new buying price must not retroactively change what earlier sales earned.
     list_price is the selling price the shop had set at the time, kept so a
     sale made below it can be shown as a discount — the agent is allowed to
     come down from the set price, and the gap is worth seeing.

     Both nullable: sales recorded before this existed, and sales of an item
     that is not in inventory, have neither. */
  await addColumnIfMissing('sales', 'cost_price', 'REAL');
  await addColumnIfMissing('sales', 'list_price', 'REAL');

  // Optional private note on a sale — "paid half, rest due next week". Shown in
  // the dashboard only; deliberately never rendered on the customer's invoice.
  await addColumnIfMissing('sales', 'comment', 'TEXT');

  /* The unit's own serial / IMEI, captured by a second scan at the till and
     printed on the money receipt so a warranty claim can be tied to the exact
     piece that was sold. TEXT for the same reason as barcode, and one per line:
     each scanned serial gets its own qty-1 line (see splitForSerial() on the
     client), so a serial never has to describe two pieces at once.

     Deliberately NOT unique. A returned piece that is resold, or an invoice
     deleted and re-entered, would both hit a unique index at the till with no
     way past it; the client warns about a serial it has seen before instead. */
  await addColumnIfMissing('sales', 'serial_no', 'TEXT');

  // TEXT, not INTEGER: an INTEGER column would eat the leading zeros off an
  // EAN-13, and Code 39 barcodes are alphanumeric.
  await addColumnIfMissing('inventory', 'barcode', 'TEXT');
  await addColumnIfMissing('inventory', 'warranty_months', 'INTEGER NOT NULL DEFAULT 0');

  // The stand-in for the UNIQUE constraint ADD COLUMN cannot express. The WHERE
  // clause is what makes barcode-less products possible: SQLite already treats
  // each NULL in a unique index as distinct, but a second product saved with an
  // empty-string barcode would otherwise collide. (validateItem also normalises
  // '' to NULL, so both ends are covered.)
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_barcode
             ON inventory(barcode) WHERE barcode IS NOT NULL AND barcode != ''`);

  // Keep this line. It is the only cheap proof at boot that the index above
  // actually exists — its absence is otherwise invisible until two products end
  // up sharing a barcode.
  const indexes = await all(`PRAGMA index_list(inventory)`);
  console.log('Inventory indexes:', indexes.map((i) => i.name).join(', ') || '(none)');

  /* Multi-item invoices. A sale row is now one *line* of an invoice; the
     invoice carries the customer, date, time and comment once. Existing
     databases get the link columns here, then every older single-item sale
     is wrapped in an invoice of its own by linkLegacySales(). */
  await addColumnIfMissing('sales', 'invoice_id', 'INTEGER');
  await addColumnIfMissing('sales', 'line_no', 'INTEGER');
  await run(`CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_id)`);

  /* How much of the invoice the customer has actually handed over. The rest is
     the due amount, and the receipt is labelled DUE or PAID accordingly.

     Nullable, and NULL does NOT mean "nothing paid" — it means "issued before
     the shop tracked dues". A NOT NULL DEFAULT 0 column would declare every
     invoice already in the ledger fully outstanding and invent a receivable
     that was never owed. The client reads NULL as settled and prints no label. */
  await addColumnIfMissing('invoices', 'paid_amount', 'REAL');

  // Every expense list is filtered by date, so that is what gets the index.
  // setup() creates the table before calling migrate(), so this can never
  // reference a table that does not exist yet.
  await run(`CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date)`);

  /* Serial-tracked stock. A product becomes tracked the moment its first
     serial is registered (see POST /api/serials/receive) — there is no switch
     to forget. From then on its quantity is the count of its available
     serials, kept in step by syncSerialStock(), rather than a number anyone
     types. Cables, bulbs and the rest never get a serial and stay 0 here,
     selling exactly as they always have. */
  await addColumnIfMissing('inventory', 'track_serial', 'INTEGER NOT NULL DEFAULT 0');
  // The typed count a product had when its first serial was scanned in, kept
  // so undoing that scan gives the count back instead of leaving stock at 0.
  await addColumnIfMissing('inventory', 'pre_serial_quantity', 'INTEGER');

  // Set when the unit on this line comes back. The line itself stays: the
  // receipt was handed over and its Invoice No. has to keep meaning the same.
  await addColumnIfMissing('sales', 'returned_date', 'TEXT');

  /* The stand-in for "a serial can be registered once, and to one product".
     Global and case-insensitive: a scanner reads SN-a9f and SN-A9F from the
     same label depending on its settings, and they are the same unit. */
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_serial_no ON product_serials(serial_no COLLATE NOCASE)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_serial_product ON product_serials(product_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_serial_events ON serial_events(serial_id)`);

  /* Faulty units of goods that carry no serial: back from a customer, not
     sellable, and not counted in `quantity`. A serial-tracked product keeps
     the same fact on each unit instead (status 'defective'). */
  await addColumnIfMissing('inventory', 'defective_quantity', 'INTEGER NOT NULL DEFAULT 0');
  await run(`CREATE INDEX IF NOT EXISTS idx_returns_invoice ON returns(invoice_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_return_lines_sale ON return_lines(sale_id)`);

  // Set while a unit is out with a customer as a warranty replacement — the
  // claim it was given under. See the warranty_claims table.
  await addColumnIfMissing('product_serials', 'claim_id', 'INTEGER');
  await run(`CREATE INDEX IF NOT EXISTS idx_claims_sale ON warranty_claims(sale_id)`);

  await linkLegacySales();
}

/* Wraps each sale recorded before invoices existed in an invoice of its own.

   The invoice takes the sale's own id wherever it is free, so every receipt
   already handed to a customer keeps the Invoice No. printed on it. Inserting
   explicit ids into an AUTOINCREMENT table also moves its counter past them,
   so new invoices continue numbering after the old ones instead of colliding.

   If that id is already taken — possible only if an old deployment wrote a
   sale after a newer one had started issuing invoices — the sale gets a fresh
   invoice number rather than being attached to a stranger's invoice.

   One write transaction for the lot. On serverless several cold instances can
   run this at once; the lock makes the second wait, and re-reading the unlinked
   rows inside the transaction means it then finds nothing left to do. */
async function linkLegacySales() {
  // A plain read first, so the write lock is only taken when there is actually
  // something to link — which, after the first successful run, is never.
  const pending = await get('SELECT COUNT(*) AS n FROM sales WHERE invoice_id IS NULL');
  if (Number(pending.n) === 0) return;

  const tx = await db.transaction('write');
  try {
    const orphans = (await tx.execute('SELECT * FROM sales WHERE invoice_id IS NULL ORDER BY id')).rows;
    const header = (sale) => [
      sale.customer_name,
      sale.customer_contact,
      sale.date,
      sale.sale_time,
      sale.comment,
    ];
    const link = (sale, invoiceId) =>
      tx.execute({ sql: 'UPDATE sales SET invoice_id = ?, line_no = 1 WHERE id = ?', args: [invoiceId, sale.id] });

    // Two passes, in this order on purpose. First, every sale whose own number
    // is still free keeps it. Only then do the rest get fresh numbers — done the
    // other way round, a sale needing a fresh number could be handed exactly the
    // number another stray sale had already printed on a customer's receipt.
    const needFresh = [];
    for (const sale of orphans) {
      const taken = (await tx.execute({ sql: 'SELECT 1 FROM invoices WHERE id = ?', args: [sale.id] })).rows.length;
      if (taken) {
        needFresh.push(sale);
        continue;
      }
      await tx.execute({
        sql: `INSERT INTO invoices (id, customer_name, customer_contact, date, sale_time, comment)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [sale.id, ...header(sale)],
      });
      await link(sale, Number(sale.id));
    }

    for (const sale of needFresh) {
      const r = await tx.execute({
        sql: `INSERT INTO invoices (customer_name, customer_contact, date, sale_time, comment)
              VALUES (?, ?, ?, ?, ?)`,
        args: header(sale),
      });
      const fresh = Number(r.lastInsertRowid);
      await link(sale, fresh);
      console.warn(`Sale ${sale.id} was numbered ${sale.id} when issued, but that invoice number was already taken; it is now invoice ${fresh}.`);
    }

    await tx.commit();
    if (orphans.length) {
      console.log(`Migrated: wrapped ${orphans.length} single-item sale(s) in invoices`);
    }
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

/* Create tables, migrate, seed the admin.

   Everything is awaited in order. The old code leaned on db.serialize() to
   sequence the CREATE TABLEs, which libSQL has no equivalent for — and does not
   need, since each awaited statement completes before the next is issued. */
/* Bump whenever setup() or migrate() gains a step. A database already at this
   version skips the whole migration on boot. */
const SCHEMA_VERSION = '2026-09-26-warranty';

// One read instead of ~20 statements, several of which take a write lock even
// when they end up changing nothing. On Vercel every cold start runs this, each
// statement a network round trip to the database — and write locks taken for
// no reason are what made simultaneous cold starts trip over each other.
async function schemaIsCurrent() {
  try {
    const row = await get(`SELECT value FROM app_meta WHERE key = 'schema_version'`);
    return row?.value === SCHEMA_VERSION;
  } catch {
    return false; // no app_meta table yet: a database from before versioning
  }
}

async function setup() {
  if (await schemaIsCurrent()) {
    // An older deployment can still be serving traffic against a database this
    // build has already migrated — a production domain not yet switched over,
    // while a preview of the new build ran the migration. That old code writes
    // sales with no invoice. Link them on every boot, not only the first, or
    // once the version says "done" they would never be wrapped. When there is
    // nothing to link this is a single read.
    await linkLegacySales();
    // The admin check stays outside the fast path too: ADMIN_EMAIL may be set on
    // a later deploy of a database that was already migrated without one.
    await seedAdmin();
    return;
  }

  await run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    cost_price REAL NOT NULL,
    selling_price REAL NOT NULL,
    barcode TEXT,
    warranty_months INTEGER NOT NULL DEFAULT 0,
    track_serial INTEGER NOT NULL DEFAULT 0,
    pre_serial_quantity INTEGER,
    defective_quantity INTEGER NOT NULL DEFAULT 0
  )`);

  // `sale_time` rather than `time`, because TIME is an SQL function name.
  // warranty_months, cost_price and list_price are all snapshotted from the
  // product at the moment of sale — see POST /api/sales — so editing a product
  // later never rewrites an invoice already issued, nor the profit already made.
  await run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_contact TEXT,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_price REAL NOT NULL,
    date TEXT NOT NULL,
    sale_time TEXT,
    warranty_months INTEGER,
    cost_price REAL,
    list_price REAL,
    comment TEXT,
    invoice_id INTEGER,
    line_no INTEGER,
    serial_no TEXT,
    returned_date TEXT
  )`);

  // One row per money receipt. Its lines live in `sales`, joined by
  // sales.invoice_id; the customer, date, time and comment are stored here once
  // rather than repeated on every line.
  //
  // paid_amount is what the customer handed over; total − paid is the due. See
  // migrate() for why it is nullable and what NULL means.
  await run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_contact TEXT,
    date TEXT NOT NULL,
    sale_time TEXT,
    comment TEXT,
    paid_amount REAL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS dealer_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    date TEXT NOT NULL
  )`);

  /* The shop's running costs — rent, electricity, salary, tea, transport.
     Deliberately NOT stock buying: goods bought for resale go through
     dealer_purchases and are already counted inside each sale line's
     snapshotted cost_price, so recording them here would charge the shop twice.

     `category` is free text with no category table behind it: the form offers a
     datalist built from the heads already used, which needs no setup and lets a
     new head be invented mid-sentence. `amount` is the whole expense, not a
     unit price. `date` is the day the money went out and stays editable, while
     `created_time` records when the row was entered and never changes. */
  await run(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    note TEXT,
    date TEXT NOT NULL,
    created_time TEXT
  )`);

  /* One row per physical unit of a serial-tracked product.

     status is 'available' (on the shelf, counted in stock), 'sold' (with a
     customer) or 'defective' (back from a customer faulty — in the shop but
     not sellable). A return in good condition goes back to 'available'.
     Everything else about a unit lives in serial_events.

     purchase_id is the dealer batch it arrived on, NULL when it was scanned in
     from the product screen (stock the shop already had). sale_id/invoice_id
     are set only while it is sold, and cleared by a return; the history of
     every sale it has been through stays in serial_events. */
  await run(`CREATE TABLE IF NOT EXISTS product_serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    serial_no TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    purchase_id INTEGER,
    sale_id INTEGER,
    invoice_id INTEGER,
    received_date TEXT NOT NULL,
    received_time TEXT,
    claim_id INTEGER
  )`);

  // What happened to a unit, in order: received, sold, returned, sold again.
  await run(`CREATE TABLE IF NOT EXISTS serial_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    invoice_id INTEGER,
    purchase_id INTEGER,
    note TEXT
  )`);

  /* Goods coming back from a customer. A return never edits the invoice it
     came from — the receipt was handed over and must keep meaning what it
     said. It is a dated record of its own that points back at it, which is
     what lets a return reduce the sales of the day it happened on while the
     invoice itself shows what was sold and what came back.

     refund_amount is the cash handed back. It is worked out, not typed: the
     customer is refunded exactly what they have paid beyond the invoice's
     new total, so a return on an invoice with money still due reduces the
     due first. See recordReturn(). */
  await run(`CREATE TABLE IF NOT EXISTS returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time TEXT,
    reason TEXT,
    refund_amount REAL NOT NULL DEFAULT 0
  )`);

  // One row per invoice line coming back. amount is this share of the line's
  // price and cost_price is copied from the line, so the profit reversed is
  // exactly the profit the sale recorded. condition is 'good' (back to stock)
  // or 'faulty' (defective, not sellable).
  await run(`CREATE TABLE IF NOT EXISTS return_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    amount REAL NOT NULL,
    cost_price REAL,
    serial_id INTEGER,
    serial_no TEXT,
    condition TEXT NOT NULL
  )`);

  /* A customer back with a faulty unit under warranty. Not a sale and not a
     return: no money moves, so nothing here can reach revenue or profit.

     The faulty unit comes in (serial → 'defective', or defective_quantity for
     goods without one). A replacement from stock goes out against the *same*
     sale line: it takes over the line's sale_id, so a later return or a second
     claim on that line acts on the unit the customer actually holds, and its
     warranty is the rest of the original's — warranty_until is copied from the
     sale when the claim is made.

     status: 'open' (unit taken in, nothing given yet), 'replaced', 'repaired'
     (the same unit handed back fixed) or 'rejected' (handed back, not covered). */
  await run(`CREATE TABLE IF NOT EXISTS warranty_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    sale_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    faulty_serial_id INTEGER,
    faulty_serial_no TEXT,
    date TEXT NOT NULL,
    time TEXT,
    problem TEXT,
    warranty_until TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    replacement_serial_id INTEGER,
    replacement_serial_no TEXT,
    resolved_date TEXT,
    resolved_time TEXT,
    resolution_note TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    password TEXT NOT NULL
  )`);

  await migrate();
  await seedAdmin();

  // Stamped last, so an interrupted setup is simply run again next time.
  await run(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
  await run(
    `INSERT INTO app_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [SCHEMA_VERSION]
  );
  console.log(`Schema is at version ${SCHEMA_VERSION}`);
}

/* The first admin comes from the environment, never from a literal in the
   source. A public deployment seeded with shop@admin.com / admin123 is owned by
   the first person who reads this repository.

   Passwords are stored as bcrypt hashes. Any plain-text password left over from
   the local-only era is upgraded in place on the owner's next successful login
   — see POST /api/login. */
async function seedAdmin() {
  const row = await get(`SELECT COUNT(*) AS count FROM admin`);
  if (Number(row.count) > 0) return;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn(
      'No admin account exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set — ' +
        'nobody can log in. Set both and restart.'
    );
    return;
  }

  // Conditional insert: two instances seeding an empty database at once would
  // otherwise both pass the count check above and create the admin twice.
  await run(
    `INSERT INTO admin (email, password)
     SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM admin)`,
    [email.trim().toLowerCase(), bcrypt.hashSync(password, 12)]
  );
  console.log(`Seeded admin account for ${email}`);
}

// Kicked off at import time; every route awaits it, so a request that arrives
// mid-setup waits rather than hitting a table that does not exist yet. That
// matters on serverless, where a cold start and the first request are
// simultaneous.
/* Setup is safe to run more than once — every step is idempotent — so when
   another instance holds the database lock (two cold starts migrating at once,
   which is ordinary on serverless) it waits briefly and tries again rather than
   giving up. */
async function setupWithRetry(attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await setup();
    } catch (err) {
      const busy = /SQLITE_BUSY|database is locked/i.test(`${err.code} ${err.message}`);
      if (!busy || attempt >= attempts) throw err;
      // Jittered: instances that collided once and back off by the same fixed
      // amount collide again on every retry, in lockstep.
      const wait = 120 * attempt + Math.random() * 250;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/* A failed setup must never take the process down. It used to be a single
   promise created at import: if it rejected before any request arrived, Node
   treated that as an unhandled rejection and exited — a crash on boot for what
   is usually a momentary lock. Now a failure is logged, forgotten, and retried
   by the next request, which gets a 503 in the meantime. */
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = setupWithRetry().catch((err) => {
      console.error('Database setup failed:', err.message);
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

// Start at boot so the first visitor does not pay for the migration.
ensureReady().catch(() => {});

app.use(async (req, res, next) => {
  try {
    await ensureReady();
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable.' });
  }
});

/* ===========================================================================
   Authentication

   Until now `isLoggedIn` was a variable in the browser and the server checked
   nothing, which was defensible while the app only ever answered on localhost.
   It is not defensible on a public URL: anyone who found it could read every
   sale and customer phone number with a single curl.

   The session is a signed JWT in an httpOnly cookie rather than server-side
   session state, because serverless instances do not share memory — there is
   nowhere to keep a session table that every invocation can see.
   =========================================================================== */

const COOKIE = 'nb_session';
const SESSION_HOURS = 12;

// Without a secret, cookies signed by one instance cannot be verified by
// another, and a restart would silently log everyone out. Refusing to start is
// better than appearing to work and failing at random.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn(
    'JWT_SECRET is not set — logins will not survive a restart. ' +
      'Set it to a long random string before deploying.'
  );
}

function issueSession(res, admin) {
  const token = jwt.sign({ sub: admin.id, email: admin.email }, JWT_SECRET || 'dev-only-insecure-secret', {
    expiresIn: `${SESSION_HOURS}h`,
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,   // unreadable to page scripts
    // HTTPS-only once deployed. Vercel sets NODE_ENV=production itself and
    // refuses to let you set it by hand, so VERCEL is checked as well — a
    // cookie that is never marked secure would travel in clear text.
    secure: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL),
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
}

function readSession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET || 'dev-only-insecure-secret');
  } catch {
    return null;   // expired or tampered with
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not signed in.' });
  req.admin = session;
  next();
}

// Slows down password guessing without needing a dependency. Per-process, so on
// serverless it resets with each cold start — a real rate limiter belongs in
// front of the app, but this removes the cheapest attack.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > 15 * 60 * 1000) {
    attempts.set(key, { count: 1, first: now });
    return false;
  }
  rec.count += 1;
  return rec.count > 10;
}

app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');

  if (tooManyAttempts(req.ip)) {
    return res.status(429).json({ success: false, message: 'Too many attempts. Wait 15 minutes.' });
  }

  try {
    const admin = await get(`SELECT * FROM admin WHERE email = ? COLLATE NOCASE`, [email]);
    // Same response whether the email is unknown or the password is wrong, so
    // the endpoint cannot be used to discover which accounts exist.
    const fail = () => res.status(401).json({ success: false, message: 'Invalid email or password' });
    if (!admin) return fail();

    const stored = String(admin.password ?? '');
    const hashed = stored.startsWith('$2');   // bcrypt hashes all begin $2a/$2b/$2y

    let ok = false;
    if (hashed) {
      ok = bcrypt.compareSync(password, stored);
    } else {
      // Left over from when passwords were stored in plain text. Accept it once,
      // then immediately replace it with a hash so it is never read again.
      ok = stored === password;
      if (ok) {
        await run(`UPDATE admin SET password = ? WHERE id = ?`, [bcrypt.hashSync(password, 12), admin.id]);
        console.log(`Upgraded plain-text password to a hash for ${admin.email}`);
      }
    }

    if (!ok) return fail();

    attempts.delete(req.ip);
    issueSession(res, admin);
    res.json({ success: true, message: 'Login successful' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not sign in.' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ success: true });
});

// Lets the browser find out whether its cookie is still good, so a restored tab
// shows the login screen instead of an empty dashboard full of failed requests.
app.get('/api/session', (req, res) => {
  const session = readSession(req);
  res.json({ authenticated: Boolean(session), email: session?.email ?? null });
});

/* Changing the password now requires being signed in AND knowing the current
   one. The old endpoint took an email and a new password from anyone on the
   network and changed the account — no old password, no token, no check of any
   kind. That is the single worst thing that could have been left exposed. */
app.post('/api/change-password', requireAuth, async (req, res) => {
  const current = String(req.body?.current_password ?? '');
  const next = String(req.body?.new_password ?? '');

  if (next.length < 8) {
    return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  }

  try {
    const admin = await get(`SELECT * FROM admin WHERE id = ?`, [req.admin.sub]);
    if (!admin) return res.status(404).json({ success: false, message: 'Account not found.' });

    const stored = String(admin.password ?? '');
    const ok = stored.startsWith('$2') ? bcrypt.compareSync(current, stored) : stored === current;
    if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });

    await run(`UPDATE admin SET password = ? WHERE id = ?`, [bcrypt.hashSync(next, 12), admin.id]);
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Could not update the password.' });
  }
});

// Everything below this line needs a valid session. Declared once, here, rather
// than remembered on each new route.
app.use('/api', requireAuth);

// API: Get Dashboard Stats & Lists
app.get('/api/data', async (req, res) => {
  try {
    // The destructure order must match the Promise.all order exactly; getting it
    // wrong is the one silent way to break this — inventory would arrive as
    // expenses and every figure on the dashboard would be nonsense.
    const [inventory, invoices, sales, purchases, expenses, returns, returnLines, claims] = await Promise.all([
      // defective_serials is the faulty count of a serial-tracked product, the
      // counterpart of defective_quantity for goods without serials.
      all(`SELECT i.*,
                  (SELECT COUNT(*) FROM product_serials ps
                    WHERE ps.product_id = i.id AND ps.status = 'defective') AS defective_serials
             FROM inventory i ORDER BY i.item_name COLLATE NOCASE`),
      all('SELECT * FROM invoices ORDER BY id DESC'),
      // `sales` are invoice lines; ordered so each invoice's lines arrive in
      // the serial order they were entered.
      all('SELECT * FROM sales ORDER BY invoice_id DESC, line_no, id'),
      all('SELECT * FROM dealer_purchases ORDER BY id DESC'),
      all('SELECT * FROM expenses ORDER BY date DESC, id DESC'),
      all('SELECT * FROM returns ORDER BY id'),
      all('SELECT * FROM return_lines ORDER BY id'),
      all('SELECT * FROM warranty_claims ORDER BY id'),
    ]);
    res.json({ inventory, invoices, sales, purchases, expenses, returns, return_lines: returnLines, warranty_claims: claims });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* How much of an invoice has been paid. Returns { error } or { paid_amount }.

   Absent, empty or null means "not tracked" and is answered with null, so a
   page cached from before this feature keeps saving sales, and clearing the
   field on an old invoice puts it back the way it was.

   Overpayment is rejected rather than clamped: a figure above the total is a
   typo or the wrong invoice, and silently swallowing it would hide both. The
   epsilon is there because the total is a sum of floats — three lines of
   666.66 add up to 1999.9799999999998, and a customer paying "the full 1999.98"
   must not be told they are overpaying. */
const PAID_EPSILON = 0.005;

function validatePaidAmount(value, total) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { paid_amount: null };
  }
  const paid = Number(value);
  if (!Number.isFinite(paid) || paid < 0) {
    return { error: 'Paid amount must be a number, zero or more.' };
  }
  if (paid > total + PAID_EPSILON) {
    return { error: `Paid amount cannot be more than the invoice total (${total.toFixed(2)}).` };
  }
  return { paid_amount: paid };
}

/* ---------------------------------------------------------------------------
   Shared plumbing for the routes that write several rows at once.
   --------------------------------------------------------------------------- */

// A refusal the shopkeeper can act on, thrown from inside a transaction so the
// rollback and the message travel together. Anything else is a real failure.
class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The same run/get/all shape as the top-level wrappers, bound to a transaction,
// so a helper can be written once and called inside or outside one.
function onTx(tx) {
  const exec = (sql, args = []) => tx.execute({ sql, args });
  return {
    run: async (sql, args) => {
      const r = await exec(sql, args);
      return { lastID: r.lastInsertRowid == null ? null : Number(r.lastInsertRowid), changes: r.rowsAffected };
    },
    get: async (sql, args) => (await exec(sql, args)).rows[0],
    all: async (sql, args) => (await exec(sql, args)).rows,
  };
}

// 'write' takes the lock up front — see the rename in PUT /api/inventory/:id
// for why a bare BEGIN would not do.
async function inWriteTx(fn) {
  const tx = await db.transaction('write');
  try {
    const out = await fn(onTx(tx));
    await tx.commit();
    return out;
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

function sendFailure(res, err) {
  if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
  if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'That barcode or serial is already registered.' });
  }
  return res.status(500).json({ error: err.message });
}

/* ---------------------------------------------------------------------------
   Serial numbers

   The character set is wider than a barcode's on purpose — a barcode is
   machine-assigned and tidy, whereas serials printed on a carton carry dots,
   slashes and underscores often enough that rejecting them would force the
   shopkeeper to retype what they just scanned. Spaces stay out: a scanner
   emits none, so a space means two codes ran together.
   --------------------------------------------------------------------------- */
const SERIAL_PATTERN = /^[0-9A-Za-z/._-]{1,64}$/;
const SERIAL_RULE = 'at most 64 letters, digits, / . _ or -, with no spaces';

// A registered serial with the product it belongs to and, while sold, the
// invoice it went out on — everything a refusal message needs to be specific.
async function findSerial(q, code) {
  return q.get(
    `SELECT ps.*, i.item_name, v.customer_name, v.date AS sold_date
       FROM product_serials ps
       LEFT JOIN inventory i ON i.id = ps.product_id
       LEFT JOIN invoices v ON v.id = ps.invoice_id
      WHERE ps.serial_no = ? COLLATE NOCASE`,
    [code]
  );
}

/* Why this serial cannot be taken in / sold as `product`, or null if it can.
   Worded for the person holding the scanner, not for a log. */
function serialClash(found, product, { forSale }) {
  if (!found) return null;
  const code = found.serial_no;
  if (found.product_id !== product.id) {
    return `${code} belongs to ${found.item_name || 'a deleted product'}, not ${product.item_name}.`;
  }
  if (found.status === 'sold') {
    const who = found.customer_name ? `, ${found.customer_name}` : '';
    return `${code} was already sold — invoice #${found.invoice_id}${who}. Return it first to sell it again.`;
  }
  if (found.status === 'defective') {
    return `${code} came back faulty and is not for sale.`;
  }
  return forSale ? null : `${code} is already in stock for ${product.item_name}.`;
}

// A product barcode scanned into a serial box would otherwise become some
// fan's serial number. The client redirects those; this is the backstop.
async function refuseProductBarcode(q, code) {
  const owner = await q.get(`SELECT item_name FROM inventory WHERE barcode = ? COLLATE NOCASE`, [code]);
  if (owner) throw new Refusal(409, `${code} is the barcode of ${owner.item_name}, not a serial number.`);
}

/* The one place a tracked product's stock is written. Counting rather than
   adding or subtracting means a count can never drift from the serials it
   describes, whatever order the writes happened in. Untracked products are
   left alone by the WHERE, so calling this on a cable is harmless. */
async function syncSerialStock(q, productId) {
  await q.run(
    `UPDATE inventory
        SET quantity = (SELECT COUNT(*) FROM product_serials WHERE product_id = inventory.id AND status = 'available')
      WHERE id = ? AND track_serial = 1`,
    [productId]
  );
}

async function logSerialEvent(q, { serial_id, event, invoice_id = null, purchase_id = null, note = null }) {
  await q.run(
    `INSERT INTO serial_events (serial_id, event, date, time, invoice_id, purchase_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [serial_id, event, todayLocal(), nowLocalTime(), invoice_id, purchase_id, note]
  );
}

// Registers one unit. Tracking starts here: the first serial on a product is
// what turns it into a serial-tracked one.
async function registerSerial(q, product, code, { purchase_id = null, note = null } = {}) {
  const r = await q.run(
    `INSERT INTO product_serials (product_id, serial_no, status, purchase_id, received_date, received_time)
     VALUES (?, ?, 'available', ?, ?, ?)`,
    [product.id, code, purchase_id, todayLocal(), nowLocalTime()]
  );
  await logSerialEvent(q, { serial_id: r.lastID, event: 'received', purchase_id, note });
  await q.run(
    `UPDATE inventory SET track_serial = 1, pre_serial_quantity = quantity WHERE id = ? AND track_serial = 0`,
    [product.id]
  );
  return r.lastID;
}

/* Creates or updates the product a dealer purchase is for, and returns it.
   Shared by the quantity form (POST /api/dealer) and the serial scanner
   (POST /api/serials/receive) so both apply the same price, barcode and
   warranty rules. Restocking *updates* the product's prices; earlier sales
   keep their own snapshotted cost_price, so this never rewrites profit
   already earned. `addQty` is 0 for the scanner, whose stock is counted. */
async function upsertPurchasedProduct(q, body, addQty) {
  const name = String(body.item_name ?? '').trim();
  if (!name) throw new Refusal(400, 'Item name is required.');

  const cost = Number(body.cost_price);
  if (!Number.isFinite(cost) || cost < 0) throw new Refusal(400, 'Buying price must be a number, zero or more.');

  const existing = await q.get(`SELECT * FROM inventory WHERE item_name = ?`, [name]);

  // Falls back to the product's current price, then to the old cost × 1.2
  // guess for a brand-new item whose page did not send one.
  const sell = body.selling_price !== undefined && body.selling_price !== '' && Number.isFinite(Number(body.selling_price))
    ? Number(body.selling_price)
    : existing
      ? existing.selling_price
      : cost * 1.2;
  if (!Number.isFinite(sell) || sell < 0) throw new Refusal(400, 'Selling price must be a number, zero or more.');

  const code = String(body.barcode ?? '').trim() || null;
  if (code && !/^[0-9A-Za-z-]{4,64}$/.test(code)) {
    throw new Refusal(400, 'Barcode must be 4–64 letters, digits or hyphens, with no spaces.');
  }
  if (code) {
    // The scan fills the item name in the form, so by submit time the two
    // agree. If they do not, the barcode belongs to something else and
    // silently moving it would be worse than refusing.
    const owner = await q.get(`SELECT item_name FROM inventory WHERE barcode = ? AND item_name != ?`, [code, name]);
    if (owner) throw new Refusal(409, `That barcode is already on "${owner.item_name}".`);
  }

  const rawWarranty = body.warranty_months;
  const warranty = rawWarranty !== undefined && rawWarranty !== '' && Number.isFinite(Number(rawWarranty))
    ? Number(rawWarranty)
    : existing?.warranty_months ?? 0;
  if (!Number.isInteger(warranty) || warranty < 0 || warranty > 600) {
    throw new Refusal(400, 'Warranty must be a whole number of months between 0 and 600.');
  }

  if (existing) {
    await q.run(
      `UPDATE inventory
          SET quantity = quantity + ?, cost_price = ?, selling_price = ?,
              warranty_months = ?, barcode = COALESCE(?, barcode)
        WHERE id = ?`,
      [addQty, cost, sell, warranty, code, existing.id]
    );
  } else {
    await q.run(
      `INSERT INTO inventory (item_name, quantity, cost_price, selling_price, barcode, warranty_months)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, addQty, cost, sell, code, warranty]
    );
  }
  return { product: await q.get(`SELECT * FROM inventory WHERE item_name = ?`, [name]), cost };
}

// API: Record a Sale — one invoice, any number of items
//
// The time of sale is stamped here, not sent by the browser. The form used to
// carry a time field pre-filled when the page loaded, which went stale the
// moment the dashboard sat open — open at 9am, sell at 3pm, invoice said 09:00.
// A client value is ignored outright rather than used as a fallback: the browser
// is the untrustworthy source here, and a PC with a wrong clock should not be
// able to stamp an invoice.
app.post('/api/sales', async (req, res) => {
  const body = req.body || {};

  const customer_name = String(body.customer_name ?? '').trim();
  const customer_contact = String(body.customer_contact ?? '').trim() || null;
  // date is NOT NULL; fall back to the shop's own calendar date, not the server's.
  const date = body.date || todayLocal();
  const comment = String(body.comment ?? '').trim() || null;

  // A page cached from before multi-item invoices posts a single item at the top
  // level. Treat it as a one-line invoice rather than rejecting a sale from a
  // shop that has not reloaded.
  const rawItems = Array.isArray(body.items)
    ? body.items
    : [{ item_name: body.item_name, quantity: body.quantity, total_price: body.total_price }];

  if (rawItems.length === 0) return res.status(400).json({ error: 'Add at least one item to the invoice.' });
  if (rawItems.length > 100) return res.status(400).json({ error: 'An invoice can have at most 100 items.' });

  const items = [];
  for (const [i, raw] of rawItems.entries()) {
    const item_name = String(raw?.item_name ?? '').trim();
    const quantity = Number(raw?.quantity);
    const total_price = Number(raw?.total_price);
    const n = i + 1;
    if (!item_name) return res.status(400).json({ error: `Item ${n}: name is required.` });
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: `Item ${n} (${item_name}): quantity must be a whole number, one or more.` });
    }
    if (!Number.isFinite(total_price) || total_price < 0) {
      return res.status(400).json({ error: `Item ${n} (${item_name}): amount must be a number, zero or more.` });
    }

    /* The piece's own serial / IMEI. Only serial-tracked products need one —
       that is checked in the transaction below, where the product is known —
       and an older cached page does not send the field at all. See
       SERIAL_PATTERN for the character set. */
    const serial_no = String(raw?.serial_no ?? '').trim() || null;
    if (serial_no && !SERIAL_PATTERN.test(serial_no)) {
      return res.status(400).json({ error: `Item ${n} (${item_name}): serial must be ${SERIAL_RULE}.` });
    }

    // Set by the till's "Sell anyway" on a serial that was never received —
    // a unit the shop had before it started scanning serials in.
    const serial_override = raw?.serial_override === true;

    items.push({ item_name, quantity, total_price, serial_no, serial_override });
  }

  /* One serial identifies one piece, so the same one twice on a single invoice
     is always a mis-scan — usually the scanner firing twice on one label. Caught
     here rather than only on the client, since the client is where a stale page
     would have skipped the check. Serials sold on *earlier* invoices are checked
     against product_serials inside the transaction; a returned piece is back to
     available there, which is how it gets resold. */
  const seenSerials = new Map();
  for (const [i, item] of items.entries()) {
    if (!item.serial_no) continue;
    const key = item.serial_no.toLowerCase();
    if (seenSerials.has(key)) {
      return res.status(400).json({
        error: `Serial ${item.serial_no} is on item ${seenSerials.get(key)} and item ${i + 1}. Each piece has its own serial.`,
      });
    }
    seenSerials.set(key, i + 1);
  }

  // Validated against the invoice's own total, which is only known now that
  // every line has been parsed.
  const invoiceTotal = items.reduce((sum, item) => sum + item.total_price, 0);
  const paid = validatePaidAmount(body.paid_amount, invoiceTotal);
  if (paid.error) return res.status(400).json({ error: paid.error });

  /* All or nothing. An invoice whose third line failed must not leave the first
     two recorded and their stock deducted — the shop would be short on stock
     with no receipt to show for it. Nor may a serial be marked sold on an
     invoice that then fails. */
  try {
    const invoiceId = await inWriteTx(async (q) => {
      const time = nowLocalTime();
      const invoice = await q.run(
        `INSERT INTO invoices (customer_name, customer_contact, date, sale_time, comment, paid_amount)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [customer_name, customer_contact, date, time, comment, paid.paid_amount]
      );
      const invoiceId = invoice.lastID;

      for (const [i, item] of items.entries()) {
        const n = i + 1;
        /* Snapshot what the product was worth at this moment.

           Exact match, not COLLATE NOCASE, because the stock decrement below
           matches exactly too — two different notions of "the same product" in
           one request would let a line inherit a cost while never reducing stock.

           An item that is not in inventory leaves all three NULL, which is a real
           path: the item field is free text. NULL renders as no warranty line and
           excludes the line from profit, which is right — the shop cannot cost, or
           honour a warranty on, something it has no record of. */
        const product = await q.get(
          `SELECT id, item_name, cost_price, selling_price, warranty_months, track_serial
             FROM inventory WHERE item_name = ?`,
          [item.item_name]
        );
        const tracked = Boolean(product && Number(product.track_serial) === 1);

        /* A serial-tracked unit has to be one the shop actually holds. Checked
           before the line is written so the refusal can say exactly why.
           Untracked goods skip all of this — a cable sells as it always has. */
        let serialRow = null;
        let serialCode = item.serial_no;
        if (tracked) {
          if (item.quantity !== 1) {
            throw new Refusal(400, `Item ${n} (${item.item_name}): one unit per line — each has its own serial.`);
          }
          if (!serialCode) {
            throw new Refusal(400, `Item ${n} (${item.item_name}) needs its serial scanned.`);
          }
          serialRow = await findSerial(q, serialCode);
          const clash = serialClash(serialRow, product, { forSale: true });
          if (clash) throw new Refusal(409, `Item ${n}: ${clash}`);
          if (!serialRow && !item.serial_override) {
            throw new Refusal(
              409,
              `Item ${n}: ${serialCode} is not in stock for ${product.item_name}. Check the label, or use Sell anyway.`
            );
          }
          if (!serialRow) await refuseProductBarcode(q, serialCode);
          // Printed as registered, so the receipt matches the stock record even
          // when the scanner read the label in a different case.
          if (serialRow) serialCode = serialRow.serial_no;
        }

        // Customer, date and time are repeated on each line so the sales table
        // still reads sensibly on its own; the invoice row is the source of truth.
        // The comment belongs to the invoice only.
        const line = await q.run(
          `INSERT INTO sales (invoice_id, line_no, customer_name, customer_contact, item_name,
                              quantity, total_price, date, sale_time,
                              warranty_months, cost_price, list_price, serial_no)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            invoiceId,
            n,
            customer_name,
            customer_contact,
            item.item_name,
            item.quantity,
            item.total_price,
            date,
            time,
            product ? product.warranty_months : null,
            product ? product.cost_price : null,
            product ? product.selling_price : null,
            serialCode,
          ]
        );

        if (!tracked) {
          // Matches on the exact item_name; a name that is not in stock silently
          // decrements nothing, which is long-standing behaviour (see README).
          await q.run(`UPDATE inventory SET quantity = quantity - ? WHERE item_name = ?`, [item.quantity, item.item_name]);
          continue;
        }

        // Sell anyway: the unit was on the shelf before serials were scanned
        // in, so it is received and sold in the same breath.
        const serialId = serialRow
          ? serialRow.id
          : await registerSerial(q, product, serialCode, { note: 'Added at the till (Sell anyway)' });

        // Guarded on status as well, so two tills selling the same unit at
        // once cannot both succeed — the second finds nothing to update.
        const sold = await q.run(
          `UPDATE product_serials SET status = 'sold', sale_id = ?, invoice_id = ?
            WHERE id = ? AND status = 'available'`,
          [line.lastID, invoiceId, serialId]
        );
        if (sold.changes !== 1) throw new Refusal(409, `Item ${n}: ${serialCode} was sold a moment ago.`);
        await logSerialEvent(q, { serial_id: serialId, event: 'sold', invoice_id: invoiceId });
        await syncSerialStock(q, product.id);
      }
      return invoiceId;
    });
    res.json({ id: invoiceId });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
});

/* API: Record Dealer Purchase — the shop's product-entry path for goods that
   are counted, not serial-numbered.

   This is where stock comes in, so it is also where prices are set: the form
   takes a buying price and a selling price per unit, and both are written onto
   the product — see upsertPurchasedProduct(). total_cost stays the stored
   figure on dealer_purchases, derived here from quantity × buying price so
   there is one source of truth.

   Serial-tracked products come in through POST /api/serials/receive instead,
   one scan per unit, and are refused here: a typed quantity of fans would add
   stock no serial stands behind. */
app.post('/api/dealer', async (req, res) => {
  const body = req.body || {};
  const dealer = String(body.dealer_name ?? '').trim();
  const qty = Number(body.quantity);

  if (!dealer) return res.status(400).json({ error: 'Dealer name is required.' });
  if (!String(body.item_name ?? '').trim()) return res.status(400).json({ error: 'Item name is required.' });
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be a whole number, one or more.' });
  }

  // A page cached from before per-unit prices still posts total_cost and no
  // prices. Derive the unit cost from it rather than rejecting the purchase of
  // a shop that has not reloaded yet.
  const fields = { ...body };
  if (!Number.isFinite(Number(body.cost_price)) && Number.isFinite(Number(body.total_cost))) {
    fields.cost_price = Number(body.total_cost) / qty;
  }

  try {
    const id = await inWriteTx(async (q) => {
      const tracked = await q.get(`SELECT item_name FROM inventory WHERE item_name = ? AND track_serial = 1`, [
        String(body.item_name).trim(),
      ]);
      if (tracked) {
        throw new Refusal(409, `${tracked.item_name} is serial-tracked — scan each unit's serial instead of typing a quantity.`);
      }
      const { product, cost } = await upsertPurchasedProduct(q, fields, qty);
      const purchase = await q.run(
        `INSERT INTO dealer_purchases (dealer_name, item_name, quantity, total_cost, date) VALUES (?, ?, ?, ?, ?)`,
        [dealer, product.item_name, qty, cost * qty, body.date || todayLocal()]
      );
      return purchase.lastID;
    });
    res.json({ id });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That barcode is already used by another product.' });
    }
    res.status(400).json({ error: err.message });
  }
});

/* ===========================================================================
   Serial / IMEI stock

   Receiving is one scan per unit, saved the moment it is scanned: there is no
   batch to lose if the browser closes, and no "Finish" to forget. The dealer
   purchase row for the batch is created by the first scan and grows by one
   with each one after, so the purchase history always matches what was
   actually scanned in.
   =========================================================================== */

/* API: Receive one unit.

   Two callers:
     - the Dealer Purchase form: dealer_name + the product's details, exactly
       as POST /api/dealer takes them, plus purchase_id from the previous scan
       of the same batch (absent on the first);
     - the product screen: product_id only, no dealer — the units the shop
       already had before it began scanning serials in. No purchase is
       recorded for those; they were bought long ago. */
app.post('/api/serials/receive', async (req, res) => {
  const body = req.body || {};
  const code = String(body.serial_no ?? '').trim();
  if (!code) return res.status(400).json({ error: 'Scan a serial number.' });
  if (!SERIAL_PATTERN.test(code)) return res.status(400).json({ error: `Serial must be ${SERIAL_RULE}.` });

  const dealer = String(body.dealer_name ?? '').trim();
  const productId = Number(body.product_id);
  if (!dealer && !productId) return res.status(400).json({ error: 'Dealer name is required.' });

  try {
    const out = await inWriteTx(async (q) => {
      let product;
      let cost = null;
      if (dealer) {
        ({ product, cost } = await upsertPurchasedProduct(q, body, 0));
      } else {
        product = await q.get(`SELECT * FROM inventory WHERE id = ?`, [productId]);
        if (!product) throw new Refusal(404, 'That product no longer exists.');
      }

      const clash = serialClash(await findSerial(q, code), product, { forSale: false });
      if (clash) throw new Refusal(409, clash);
      await refuseProductBarcode(q, code);

      let purchaseId = null;
      if (dealer) {
        const date = body.date || todayLocal();
        const prior = Number(body.purchase_id)
          ? await q.get(`SELECT * FROM dealer_purchases WHERE id = ?`, [Number(body.purchase_id)])
          : null;
        // Only the same batch keeps growing. A different product, dealer or
        // date starts a new purchase row, so none can absorb another's units.
        if (prior && prior.item_name === product.item_name && prior.dealer_name === dealer && prior.date === date) {
          await q.run(`UPDATE dealer_purchases SET quantity = quantity + 1, total_cost = total_cost + ? WHERE id = ?`, [
            cost,
            prior.id,
          ]);
          purchaseId = prior.id;
        } else {
          const r = await q.run(
            `INSERT INTO dealer_purchases (dealer_name, item_name, quantity, total_cost, date) VALUES (?, ?, 1, ?, ?)`,
            [dealer, product.item_name, cost, date]
          );
          purchaseId = r.lastID;
        }
      }

      const serialId = await registerSerial(q, product, code, { purchase_id: purchaseId });
      await syncSerialStock(q, product.id);
      return {
        purchase_id: purchaseId,
        serial: await q.get(`SELECT * FROM product_serials WHERE id = ?`, [serialId]),
        product: await q.get(`SELECT * FROM inventory WHERE id = ?`, [product.id]),
      };
    });
    res.json(out);
  } catch (err) {
    sendFailure(res, err);
  }
});

/* API: Undo a mis-scanned unit.

   Only while it is still on the shelf: a sold unit is on a customer's receipt
   and comes back through a return, never by being deleted. The unit's batch
   shrinks by one at that batch's own unit price, and a batch left empty goes
   with it. Nothing is kept of the serial — it never really arrived.

   If that was the product's last serial of any status, the product goes back
   to being untracked with the count it had before, so a cable given a serial
   by mistake is not stuck asking for serials at the till forever. */
app.delete('/api/serials/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const product = await inWriteTx(async (q) => {
      const unit = await q.get(`SELECT * FROM product_serials WHERE id = ?`, [id]);
      if (!unit) throw new Refusal(404, 'That serial is not registered.');
      if (unit.status === 'sold') {
        throw new Refusal(409, `${unit.serial_no} has been sold. Use Return to bring it back into stock.`);
      }
      // Remove is for a mis-scan. A faulty unit really exists, and has a sale
      // and a return behind it that its history must keep.
      if (unit.status !== 'available') {
        throw new Refusal(409, `${unit.serial_no} came back faulty, so it has history. It cannot be removed.`);
      }

      if (unit.purchase_id) {
        const batch = await q.get(`SELECT * FROM dealer_purchases WHERE id = ?`, [unit.purchase_id]);
        if (batch && Number(batch.quantity) > 1) {
          await q.run(
            `UPDATE dealer_purchases SET quantity = quantity - 1, total_cost = total_cost - total_cost / quantity WHERE id = ?`,
            [batch.id]
          );
        } else if (batch) {
          await q.run(`DELETE FROM dealer_purchases WHERE id = ?`, [batch.id]);
        }
      }

      await q.run(`DELETE FROM serial_events WHERE serial_id = ?`, [id]);
      await q.run(`DELETE FROM product_serials WHERE id = ?`, [id]);
      const left = await q.get(`SELECT COUNT(*) AS n FROM product_serials WHERE product_id = ?`, [unit.product_id]);
      if (Number(left.n) === 0) {
        await q.run(
          `UPDATE inventory SET track_serial = 0, quantity = COALESCE(pre_serial_quantity, 0), pre_serial_quantity = NULL
            WHERE id = ?`,
          [unit.product_id]
        );
      } else {
        await syncSerialStock(q, unit.product_id);
      }
      return q.get(`SELECT * FROM inventory WHERE id = ?`, [unit.product_id]);
    });
    res.json({ success: true, product: product ?? null });
  } catch (err) {
    sendFailure(res, err);
  }
});

// API: What is this serial? One lookup per till scan, so the cashier hears
// the answer before the invoice is saved rather than after.
app.get('/api/serials/lookup', async (req, res) => {
  const code = String(req.query.code ?? '').trim();
  if (!code) return res.status(400).json({ error: 'Scan a serial number.' });
  try {
    const found = await findSerial({ get }, code);
    if (!found) return res.status(404).json({ error: `${code} is not registered.` });
    res.json(found);
  } catch (err) {
    sendFailure(res, err);
  }
});

/* API: The Serial / IMEI list — search, filter, page.

   Server-side rather than shipped with /api/data: a shop that has sold phones
   for a year has thousands of serials, and the dashboard does not need any of
   them to load. */
app.get('/api/serials', async (req, res) => {
  const where = [];
  const args = [];
  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push(`(ps.serial_no LIKE ? OR i.item_name LIKE ? OR v.customer_name LIKE ?)`);
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (Number(req.query.product_id)) {
    where.push(`ps.product_id = ?`);
    args.push(Number(req.query.product_id));
  }
  if (['available', 'sold', 'defective'].includes(req.query.status)) {
    where.push(`ps.status = ?`);
    args.push(req.query.status);
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const from = `FROM product_serials ps
                LEFT JOIN inventory i ON i.id = ps.product_id
                LEFT JOIN invoices v ON v.id = ps.invoice_id
                LEFT JOIN dealer_purchases d ON d.id = ps.purchase_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  try {
    const [rows, count] = await Promise.all([
      all(
        `SELECT ps.*, i.item_name, v.customer_name, v.customer_contact, v.date AS sold_date, d.dealer_name
           ${from}
          ORDER BY ps.id DESC LIMIT ? OFFSET ?`,
        [...args, limit, offset]
      ),
      get(`SELECT COUNT(*) AS n ${from}`, args),
    ]);
    res.json({ rows, total: Number(count.n) });
  } catch (err) {
    sendFailure(res, err);
  }
});

// API: Everything that has happened to one unit, oldest first.
app.get('/api/serials/:id/history', async (req, res) => {
  const id = Number(req.params.id);
  try {
    const unit = await get(
      `SELECT ps.*, i.item_name FROM product_serials ps LEFT JOIN inventory i ON i.id = ps.product_id WHERE ps.id = ?`,
      [id]
    );
    if (!unit) return res.status(404).json({ error: 'That serial is not registered.' });
    const events = await all(
      `SELECT e.*, v.customer_name, v.customer_contact, d.dealer_name
         FROM serial_events e
         LEFT JOIN invoices v ON v.id = e.invoice_id
         LEFT JOIN dealer_purchases d ON d.id = e.purchase_id
        WHERE e.serial_id = ?
        ORDER BY e.id`,
      [id]
    );
    res.json({ serial: unit, events });
  } catch (err) {
    sendFailure(res, err);
  }
});

/* ===========================================================================
   Returns

   Goods coming back from a customer, full or partial, with or without a
   serial. One return is one dated record against one invoice, carrying every
   line that came back and the cash handed over the counter for it. The
   invoice itself is never edited — see the returns table in setup().
   =========================================================================== */

const round2 = (n) => Math.round(n * 100) / 100;

/* An invoice's money after any returns, in the one shape the client mirrors
   (invoiceNet / invoicePaid / invoiceDue in app.js):

     net  = what the lines came to, less what came back
     paid = what the customer has handed over, less what was refunded

   A NULL paid_amount is an invoice from before dues were tracked, read as
   settled in full — the same reading the client gives it. */
async function invoiceMoney(q, invoiceId) {
  const inv = await q.get(`SELECT paid_amount FROM invoices WHERE id = ?`, [invoiceId]);
  if (!inv) return null;
  const sold = await q.get(`SELECT COALESCE(SUM(total_price), 0) AS n FROM sales WHERE invoice_id = ?`, [invoiceId]);
  const back = await q.get(
    `SELECT COALESCE(SUM(rl.amount), 0) AS n FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE r.invoice_id = ?`,
    [invoiceId]
  );
  const refunds = await q.get(`SELECT COALESCE(SUM(refund_amount), 0) AS n FROM returns WHERE invoice_id = ?`, [invoiceId]);

  const gross = Number(sold.n);
  const refunded = Number(refunds.n);
  const paidIn = inv.paid_amount == null ? gross : Number(inv.paid_amount);
  return { gross, refunded, net: gross - Number(back.n), paid: paidIn - refunded };
}

/* Records one return against `invoiceId`, inside the caller's transaction.
   `lines` is [{ sale_id, quantity, condition }]. Returns { id, refund_amount }.

   Per line, in the same breath as the return row:
     - a unit with a serial goes back to 'available' (good) or 'defective'
       (faulty), is unlinked from the sale, and gets a history event;
     - goods without one go back into quantity (good) or defective_quantity
       (faulty) on the product of the same name — the same exact-name match
       the sale used to take them out.

   Nothing here can return more than was sold: each line's earlier returns are
   read inside the same write transaction, so two returns racing each other
   cannot both take the last unit. */
async function recordReturn(q, invoiceId, rawLines, reason) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new Refusal(400, 'Choose at least one item to return.');
  if (rawLines.length > 100) throw new Refusal(400, 'A return can have at most 100 lines.');

  const money = await invoiceMoney(q, invoiceId);
  if (!money) throw new Refusal(404, 'That invoice no longer exists.');

  const lines = [];
  const seen = new Set();
  for (const raw of rawLines) {
    const saleId = Number(raw?.sale_id);
    const quantity = Number(raw?.quantity);
    const condition = raw?.condition === 'faulty' ? 'faulty' : raw?.condition === 'good' ? 'good' : null;
    if (!Number.isInteger(saleId) || seen.has(saleId)) throw new Refusal(400, 'Each item can be listed once per return.');
    seen.add(saleId);

    const line = await q.get(`SELECT * FROM sales WHERE id = ? AND invoice_id = ?`, [saleId, invoiceId]);
    if (!line) throw new Refusal(400, `That item is not on invoice #${invoiceId}.`);
    if (!condition) throw new Refusal(400, `${line.item_name}: say whether it came back good or faulty.`);

    const prev = await q.get(
      `SELECT COALESCE(SUM(quantity), 0) AS qty, COALESCE(SUM(amount), 0) AS amount FROM return_lines WHERE sale_id = ?`,
      [saleId]
    );
    const left = Number(line.quantity) - Number(prev.qty);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Refusal(400, `${line.item_name}: quantity must be a whole number, one or more.`);
    }
    // Units already in the shop on an open warranty claim are not the
    // customer's to return; the claim has to be settled first.
    const held = await openClaimQty(q, saleId);
    if (held > 0 && quantity > left - held) {
      throw new Refusal(409, `${line.item_name}: ${held} is in the shop on an open warranty claim. Settle the claim first.`);
    }
    if (quantity > left) {
      throw new Refusal(
        409,
        left > 0
          ? `${line.item_name}: only ${left} of ${line.quantity} is left to return.`
          : `${line.item_name}: all ${line.quantity} already came back.`
      );
    }

    // The last units take whatever of the line's price is left, so rounding
    // on earlier partial returns can never leave a paisa stranded on it.
    const amount = quantity === left
      ? round2(Number(line.total_price) - Number(prev.amount))
      : round2((Number(line.total_price) * quantity) / Number(line.quantity));

    lines.push({ line, quantity, condition, amount, fullyBack: quantity === left });
  }

  // The customer gets back exactly what they have paid beyond the new total:
  // a fully paid invoice refunds the returned amount, one with money still
  // due has the due reduced first.
  const newNet = money.net - lines.reduce((sum, l) => sum + l.amount, 0);
  const over = round2(money.paid - newNet);
  const refund = over > PAID_EPSILON ? over : 0;

  const date = todayLocal();
  const r = await q.run(
    `INSERT INTO returns (invoice_id, date, time, reason, refund_amount) VALUES (?, ?, ?, ?, ?)`,
    [invoiceId, date, nowLocalTime(), reason, refund]
  );
  const returnId = r.lastID;

  for (const { line, quantity, condition, amount, fullyBack } of lines) {
    // The unit sold on this line, if it carries a serial the shop tracks.
    const unit = await q.get(`SELECT * FROM product_serials WHERE sale_id = ? AND status = 'sold'`, [line.id]);

    await q.run(
      `INSERT INTO return_lines (return_id, sale_id, item_name, quantity, amount, cost_price, serial_id, serial_no, condition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [returnId, line.id, line.item_name, quantity, amount, line.cost_price, unit?.id ?? null, unit?.serial_no ?? line.serial_no ?? null, condition]
    );

    if (unit) {
      await q.run(
        `UPDATE product_serials SET status = ?, sale_id = NULL, invoice_id = NULL WHERE id = ?`,
        [condition === 'good' ? 'available' : 'defective', unit.id]
      );
      const note = [condition === 'faulty' ? 'Faulty' : null, reason].filter(Boolean).join(' — ') || null;
      await logSerialEvent(q, { serial_id: unit.id, event: 'returned', invoice_id: invoiceId, note });
      await syncSerialStock(q, unit.product_id);
    } else {
      // track_serial = 0 only: a tracked product's stock is counted from its
      // serials, so adding to it by hand would be undone at the next count.
      await q.run(
        condition === 'good'
          ? `UPDATE inventory SET quantity = quantity + ? WHERE item_name = ? AND track_serial = 0`
          : `UPDATE inventory SET defective_quantity = defective_quantity + ? WHERE item_name = ? AND track_serial = 0`,
        [quantity, line.item_name]
      );
    }

    // Kept for the "(returned)" labels, which predate partial returns.
    if (fullyBack) await q.run(`UPDATE sales SET returned_date = ? WHERE id = ?`, [date, line.id]);
  }

  return { id: returnId, refund_amount: refund };
}

// API: Record a return against an invoice — any lines, any quantities.
app.post('/api/invoices/:id/returns', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid invoice.' });
  const reason = String(req.body?.reason ?? '').trim().slice(0, 200) || null;
  try {
    const out = await inWriteTx((q) => recordReturn(q, id, req.body?.lines, reason));
    res.json(out);
  } catch (err) {
    sendFailure(res, err);
  }
});

/* API: One sold unit back, in good condition — what the serial list's Return
   button posted before returns had a dialog of their own. Kept so a page
   cached from then still records a proper return, refund and all. */
app.post('/api/serials/:id/return', async (req, res) => {
  const id = Number(req.params.id);
  const note = String(req.body?.note ?? '').trim().slice(0, 200) || null;
  try {
    const product = await inWriteTx(async (q) => {
      const unit = await q.get(`SELECT * FROM product_serials WHERE id = ?`, [id]);
      if (!unit) throw new Refusal(404, 'That serial is not registered.');
      if (unit.status !== 'sold') throw new Refusal(409, `${unit.serial_no} is not sold — there is nothing to return.`);
      if (!unit.sale_id || !unit.invoice_id) throw new Refusal(409, `${unit.serial_no} is not linked to an invoice line.`);

      await recordReturn(q, unit.invoice_id, [{ sale_id: unit.sale_id, quantity: 1, condition: 'good' }], note);
      return q.get(`SELECT * FROM inventory WHERE id = ?`, [unit.product_id]);
    });
    res.json({ success: true, product: product ?? null });
  } catch (err) {
    sendFailure(res, err);
  }
});

/* ===========================================================================
   Warranty claims

   A faulty unit in, and — now or later — a replacement from stock out, the
   same unit handed back repaired, or handed back as not covered. No money
   moves and no sale is written, so a replacement can never show up as
   revenue. See the warranty_claims table in setup().
   =========================================================================== */

// The same month arithmetic as addMonths() in app.js, which prints the
// warranty on the receipt; the two must agree on when a warranty ends.
function addMonthsTo(dateStr, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  const n = Number(months);
  if (!m || months == null || !Number.isFinite(n) || n <= 0) return null;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (x) => String(x).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(Number(m[3]), lastDay))}`;
}

// Units of a sale line sitting in the shop on claims not yet settled.
async function openClaimQty(q, saleId) {
  const row = await q.get(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM warranty_claims WHERE sale_id = ? AND status = 'open'`,
    [saleId]
  );
  return Number(row.n);
}

/* Hands a replacement out against an open claim and closes it as 'replaced'.
   A serial product needs `code`: an available unit of the same product, which
   goes out linked to the original sale line. Goods without serials come off
   the shelf count. Refuses rather than lets stock go below zero. */
async function giveReplacement(q, claim, line, product, code) {
  if (!product) throw new Refusal(409, `${line.item_name} is not a product in stock, so nothing can be given from stock.`);
  let replacement = { id: null, serial_no: null };

  if (Number(product.track_serial) === 1) {
    if (!code) throw new Refusal(400, `Scan the serial of the ${product.item_name} being given.`);
    if (!SERIAL_PATTERN.test(code)) throw new Refusal(400, `Serial must be ${SERIAL_RULE}.`);
    const found = await findSerial(q, code);
    if (!found) throw new Refusal(409, `${code} is not in stock. Scan it in first — Dealer Purchase, or the product's Edit screen.`);
    const clash = serialClash(found, product, { forSale: true });
    if (clash) throw new Refusal(409, clash);

    const out = await q.run(
      `UPDATE product_serials SET status = 'sold', sale_id = ?, invoice_id = ?, claim_id = ?
        WHERE id = ? AND status = 'available'`,
      [line.id, line.invoice_id, claim.id, found.id]
    );
    if (out.changes !== 1) throw new Refusal(409, `${found.serial_no} was sold a moment ago.`);
    const faulty = claim.faulty_serial_no ? ` for ${claim.faulty_serial_no}` : '';
    await logSerialEvent(q, {
      serial_id: found.id,
      event: 'replacement_out',
      invoice_id: line.invoice_id,
      note: `Warranty replacement${faulty} — claim #${claim.id}`,
    });
    await syncSerialStock(q, product.id);
    replacement = found;
  } else {
    const taken = await q.run(
      `UPDATE inventory SET quantity = quantity - ? WHERE id = ? AND quantity >= ?`,
      [claim.quantity, product.id, claim.quantity]
    );
    if (taken.changes !== 1) {
      throw new Refusal(409, `Not enough ${product.item_name} in stock to replace ${claim.quantity}. Save the claim as open instead.`);
    }
  }

  await q.run(
    `UPDATE warranty_claims
        SET status = 'replaced', replacement_serial_id = ?, replacement_serial_no = ?, resolved_date = ?, resolved_time = ?
      WHERE id = ?`,
    [replacement.id, replacement.serial_no, todayLocal(), nowLocalTime(), claim.id]
  );
}

/* API: A customer brings a unit back under warranty.

   Body: { sale_id, quantity?, problem?, replace_now?, replacement_serial_no? }

   Serial lines claim the one unit the customer holds on that line — the
   original, or an earlier replacement. Other lines claim a quantity, up to
   what has not been returned or already claimed. An expired warranty is not
   refused: honouring one anyway is the shop's call, and the dialog warns. */
app.post('/api/warranty-claims', async (req, res) => {
  const body = req.body || {};
  const saleId = Number(body.sale_id);
  const problem = String(body.problem ?? '').trim().slice(0, 200) || null;
  const code = String(body.replacement_serial_no ?? '').trim() || null;
  try {
    const claim = await inWriteTx(async (q) => {
      const line = await q.get(`SELECT * FROM sales WHERE id = ?`, [saleId]);
      if (!line || !line.invoice_id) throw new Refusal(404, 'That invoice line no longer exists.');
      const product = await q.get(`SELECT * FROM inventory WHERE item_name = ?`, [line.item_name]);

      // The unit with the customer on this line, if serials are tracked.
      const unit = await q.get(`SELECT * FROM product_serials WHERE sale_id = ? AND status = 'sold'`, [line.id]);
      /* Without a tracked unit — goods with no serial, or a line sold before
         its product was serial-tracked — a quantity is claimed, up to what is
         still with the customer: not returned, and not already in on a claim. */
      let quantity = 1;
      if (!unit) {
        const back = await q.get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM return_lines WHERE sale_id = ?`, [line.id]);
        const held = await openClaimQty(q, line.id);
        const free = Number(line.quantity) - Number(back.n) - held;
        quantity = body.quantity == null || body.quantity === '' ? 1 : Number(body.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) throw new Refusal(400, 'Quantity must be a whole number, one or more.');
        if (quantity > free) {
          throw new Refusal(
            409,
            free > 0
              ? `Only ${free} of ${line.item_name} on this line can be claimed.`
              : held
                ? `${line.item_name} on this line is already in the shop on an open claim.`
                : `Nothing on this line is with the customer any more.`
          );
        }
      }

      const r = await q.run(
        `INSERT INTO warranty_claims (invoice_id, sale_id, item_name, quantity, faulty_serial_id, faulty_serial_no,
                                      date, time, problem, warranty_until, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        [
          line.invoice_id, line.id, line.item_name, quantity,
          unit?.id ?? null, unit?.serial_no ?? line.serial_no ?? null,
          todayLocal(), nowLocalTime(), problem, addMonthsTo(line.date, line.warranty_months),
        ]
      );
      const claim = await q.get(`SELECT * FROM warranty_claims WHERE id = ?`, [r.lastID]);

      // The faulty unit comes in and is kept aside, not for sale.
      if (unit) {
        await q.run(
          `UPDATE product_serials SET status = 'defective', sale_id = NULL, invoice_id = NULL, claim_id = NULL WHERE id = ?`,
          [unit.id]
        );
        await logSerialEvent(q, {
          serial_id: unit.id,
          event: 'claimed',
          invoice_id: line.invoice_id,
          note: [`Warranty claim #${claim.id}`, problem].filter(Boolean).join(' — '),
        });
        await syncSerialStock(q, unit.product_id);
      } else if (product) {
        // For a tracked product this is a unit that never had its serial
        // registered; it is counted with the faulty serials — see faultyCount().
        await q.run(`UPDATE inventory SET defective_quantity = defective_quantity + ? WHERE id = ?`, [quantity, product.id]);
      }

      if (body.replace_now) await giveReplacement(q, claim, line, product, code);
      return q.get(`SELECT * FROM warranty_claims WHERE id = ?`, [claim.id]);
    });
    res.json(claim);
  } catch (err) {
    sendFailure(res, err);
  }
});

/* API: Settle an open claim.

   Body: { action: 'replace' | 'repaired' | 'rejected', replacement_serial_no?, note? }

   'replace' hands out a unit from stock, as replace_now does above.
   'repaired' and 'rejected' both give the customer's own unit back — fixed,
   or as it was — so it leaves the faulty pile and is with them again. */
app.post('/api/warranty-claims/:id/resolve', async (req, res) => {
  const id = Number(req.params.id);
  const action = String(req.body?.action ?? '');
  const note = String(req.body?.note ?? '').trim().slice(0, 200) || null;
  const code = String(req.body?.replacement_serial_no ?? '').trim() || null;
  if (!['replace', 'repaired', 'rejected'].includes(action)) {
    return res.status(400).json({ error: 'Choose replace, repaired or not covered.' });
  }
  try {
    const claim = await inWriteTx(async (q) => {
      const claim = await q.get(`SELECT * FROM warranty_claims WHERE id = ?`, [id]);
      if (!claim) throw new Refusal(404, 'That claim no longer exists.');
      if (claim.status !== 'open') throw new Refusal(409, `Claim #${id} is already settled.`);
      const line = await q.get(`SELECT * FROM sales WHERE id = ?`, [claim.sale_id]);
      if (!line) throw new Refusal(409, 'The invoice line this claim is on no longer exists.');
      const product = await q.get(`SELECT * FROM inventory WHERE item_name = ?`, [line.item_name]);

      if (action === 'replace') {
        await giveReplacement(q, claim, line, product, code);
      } else {
        if (claim.faulty_serial_id) {
          const unit = await q.get(`SELECT * FROM product_serials WHERE id = ?`, [claim.faulty_serial_id]);
          if (!unit) throw new Refusal(409, `${claim.faulty_serial_no} is no longer registered.`);
          if (unit.status !== 'defective') {
            throw new Refusal(409, `${unit.serial_no} is not in the faulty pile any more, so it cannot be handed back.`);
          }
          await q.run(
            `UPDATE product_serials SET status = 'sold', sale_id = ?, invoice_id = ? WHERE id = ?`,
            [line.id, line.invoice_id, unit.id]
          );
          await logSerialEvent(q, {
            serial_id: unit.id,
            event: action === 'repaired' ? 'repaired' : 'claim_rejected',
            invoice_id: line.invoice_id,
            note: [`Claim #${id}`, note].filter(Boolean).join(' — '),
          });
          await syncSerialStock(q, unit.product_id);
        } else if (product) {
          await q.run(
            `UPDATE inventory SET defective_quantity = MAX(0, defective_quantity - ?) WHERE id = ?`,
            [claim.quantity, product.id]
          );
        }
        await q.run(
          `UPDATE warranty_claims SET status = ?, resolved_date = ?, resolved_time = ? WHERE id = ?`,
          [action, todayLocal(), nowLocalTime(), id]
        );
      }
      if (note) await q.run(`UPDATE warranty_claims SET resolution_note = ? WHERE id = ?`, [note, id]);
      return q.get(`SELECT * FROM warranty_claims WHERE id = ?`, [id]);
    });
    res.json(claim);
  } catch (err) {
    sendFailure(res, err);
  }
});

/* ===========================================================================
   Products (inventory)

   Until these existed, a product could only be created as a side effect of a
   dealer purchase, and a typo'd name, a wrong price or a miscounted stock
   level could never be corrected except by editing shop.db by hand.
   =========================================================================== */

// Shared shape check for POST and PUT, so both agree on what a product is.
// Returns { error } or { item }.
function validateItem(body = {}) {
  const item_name = String(body.item_name ?? '').trim();
  if (!item_name) return { error: 'Item name is required.' };
  if (item_name.length > 120) return { error: 'Item name is too long (max 120 characters).' };

  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) {
    return { error: 'Quantity must be a whole number, zero or more.' };
  }

  const cost_price = Number(body.cost_price);
  const selling_price = Number(body.selling_price);
  if (!Number.isFinite(cost_price) || cost_price < 0) {
    return { error: 'Buying price must be a number, zero or more.' };
  }
  if (!Number.isFinite(selling_price) || selling_price < 0) {
    return { error: 'Selling price must be a number, zero or more.' };
  }

  const warranty_months =
    body.warranty_months === '' || body.warranty_months == null ? 0 : Number(body.warranty_months);
  if (!Number.isInteger(warranty_months) || warranty_months < 0 || warranty_months > 600) {
    return { error: 'Warranty must be a whole number of months between 0 and 600.' };
  }

  // Normalised to NULL when blank so the partial unique index never sees an
  // empty string, and so many barcode-less products can coexist.
  const raw = String(body.barcode ?? '').trim();
  const barcode = raw === '' ? null : raw;
  if (barcode && !/^[0-9A-Za-z-]{4,64}$/.test(barcode)) {
    return { error: 'Barcode must be 4–64 letters, digits or hyphens, with no spaces.' };
  }

  return { item: { item_name, quantity, cost_price, selling_price, warranty_months, barcode } };
}

// Name and barcode must each identify one product. Name uniqueness is checked
// here rather than with a second unique index because a UNIQUE ... COLLATE
// NOCASE index would fail to create if the live database already held a
// case-variant pair — and that failure would be silent.
async function findConflict(item, excludeId = null) {
  const params = excludeId ? [item.item_name, excludeId] : [item.item_name];
  const byName = await get(
    `SELECT id FROM inventory WHERE item_name = ? COLLATE NOCASE${excludeId ? ' AND id != ?' : ''}`,
    params
  );
  if (byName) return `An item named "${item.item_name}" already exists.`;

  if (item.barcode) {
    const byCode = await get(
      `SELECT item_name FROM inventory WHERE barcode = ?${excludeId ? ' AND id != ?' : ''}`,
      excludeId ? [item.barcode, excludeId] : [item.barcode]
    );
    if (byCode) return `That barcode is already on "${byCode.item_name}".`;
  }
  return null;
}

// API: Create a product
//
// `serials` is optional: the units of a new serial-tracked product, scanned in
// the Add Product form before it existed. They are registered in the same
// transaction as the product, so a serial that turns out to be taken leaves
// no half-created product behind. With serials, stock is their count and any
// typed quantity is ignored.
app.post('/api/inventory', async (req, res) => {
  const { error, item } = validateItem(req.body);
  if (error) return res.status(400).json({ error });

  const serials = Array.isArray(req.body?.serials)
    ? req.body.serials.map((c) => String(c ?? '').trim()).filter(Boolean)
    : [];
  if (serials.length > 1000) return res.status(400).json({ error: 'At most 1000 serials at once.' });
  const seen = new Set();
  for (const code of serials) {
    if (!SERIAL_PATTERN.test(code)) return res.status(400).json({ error: `Serial ${code} must be ${SERIAL_RULE}.` });
    if (seen.has(code.toLowerCase())) return res.status(400).json({ error: `Serial ${code} is scanned twice.` });
    seen.add(code.toLowerCase());
  }

  try {
    const conflict = await findConflict(item);
    if (conflict) return res.status(409).json({ error: conflict });

    const id = await inWriteTx(async (q) => {
      const result = await q.run(
        `INSERT INTO inventory (item_name, quantity, cost_price, selling_price, barcode, warranty_months)
         VALUES (?, ?, ?, ?, ?, ?)`,
        // 0 rather than the typed count when serials come along: that is the
        // count an undo of every serial would fall back to.
        [item.item_name, serials.length ? 0 : item.quantity, item.cost_price, item.selling_price, item.barcode, item.warranty_months]
      );
      const product = { id: result.lastID, item_name: item.item_name };
      for (const code of serials) {
        const clash = serialClash(await findSerial(q, code), product, { forSale: false });
        if (clash) throw new Refusal(409, clash);
        if (item.barcode && code.toLowerCase() === item.barcode.toLowerCase()) {
          throw new Refusal(409, `${code} is this product's barcode, not a serial number.`);
        }
        await refuseProductBarcode(q, code);
        await registerSerial(q, product, code);
      }
      if (serials.length) await syncSerialStock(q, product.id);
      return product.id;
    });
    res.json({ id });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ error: err.message });
    // The partial index is the actual guarantee; the pre-check above only
    // exists to produce a message a shopkeeper can act on.
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That barcode is already used by another product.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// API: Update a product, cascading a rename through its history
app.put('/api/inventory/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { error, item } = validateItem(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const existing = await get(`SELECT * FROM inventory WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'That product no longer exists.' });

    const conflict = await findConflict(item, id);
    if (conflict) return res.status(409).json({ error: conflict });

    // A serial-tracked product's stock is its count of available serials, so
    // a typed quantity is ignored rather than allowed to disagree with them.
    if (Number(existing.track_serial) === 1) item.quantity = Number(existing.quantity);

    const oldName = existing.item_name;
    const renamed = oldName !== item.item_name;
    const fields = [
      item.item_name,
      item.quantity,
      item.cost_price,
      item.selling_price,
      item.barcode,
      item.warranty_months,
      id,
    ];
    const updateItem = `UPDATE inventory
         SET item_name = ?, quantity = ?, cost_price = ?, selling_price = ?,
             barcode = ?, warranty_months = ?
       WHERE id = ?`;

    if (!renamed) {
      await run(updateItem, fields);
      return res.json({ success: true, renamed: 0 });
    }

    /* item_name is the only link between a product and its history, so a
       rename has to carry the history with it or the past sales are orphaned
       on a string nothing explains.

       Note this deliberately does change what an already-issued invoice
       reprints — which is the opposite of the warranty and cost snapshots
       above, and for a reason: a rename is a *correction* (the typo was on the
       customer's copy too), whereas a price or warranty change is a new
       decision that must not rewrite a promise already made.

       Driven through the client's own transaction API rather than by issuing
       BEGIN / COMMIT as statements. libSQL manages transactions itself, and a
       bare `BEGIN IMMEDIATE` is rejected — it would have left this running as
       three separate unprotected writes, which is exactly the failure this
       block exists to prevent. 'write' is the equivalent of BEGIN IMMEDIATE:
       it takes the write lock up front rather than upgrading at COMMIT. */
    const tx = await db.transaction('write');
    try {
      await tx.execute({ sql: updateItem, args: fields });
      const s = await tx.execute({
        sql: `UPDATE sales SET item_name = ? WHERE item_name = ?`,
        args: [item.item_name, oldName],
      });
      const p = await tx.execute({
        sql: `UPDATE dealer_purchases SET item_name = ? WHERE item_name = ?`,
        args: [item.item_name, oldName],
      });
      const r = await tx.execute({
        sql: `UPDATE return_lines SET item_name = ? WHERE item_name = ?`,
        args: [item.item_name, oldName],
      });
      const w = await tx.execute({
        sql: `UPDATE warranty_claims SET item_name = ? WHERE item_name = ?`,
        args: [item.item_name, oldName],
      });
      await tx.commit();
      res.json({ success: true, renamed: s.rowsAffected + p.rowsAffected + r.rowsAffected + w.rowsAffected });
    } catch (txErr) {
      await tx.rollback().catch(() => {});
      throw txErr;
    }
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That barcode is already used by another product.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// API: Delete a product
//
// Allowed even when sales reference it. The commonest reason to delete is a
// typo'd product auto-created by a dealer purchase, which always has history
// attached — refusing those would block the very case this exists for. Nothing
// on a printed invoice is lost: each sale snapshots the name, price, cost and
// warranty it was issued with. The UI confirms with the reference count first.
//
// Its registered serials go with it: they describe units of a product that no
// longer exists. Receipts already printed keep the serial on their own line.
app.delete('/api/inventory/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    await inWriteTx(async (q) => {
      await q.run(
        `DELETE FROM serial_events WHERE serial_id IN (SELECT id FROM product_serials WHERE product_id = ?)`,
        [id]
      );
      await q.run(`DELETE FROM product_serials WHERE product_id = ?`, [id]);
      const result = await q.run(`DELETE FROM inventory WHERE id = ?`, [id]);
      if (result.changes === 0) throw new Refusal(404, 'That product no longer exists.');
    });
    res.json({ success: true });
  } catch (err) {
    sendFailure(res, err);
  }
});

/* ===========================================================================
   Expenses (খরচ)

   The shop's running costs. Sales tell it what it earned on goods; without
   these, "profit" is not what it actually made at the end of the month.

   Deliberately separate from dealer_purchases: stock bought for resale is
   already inside each sale line's snapshotted cost_price, so counting it here
   as well would subtract it twice. The form says so; the server cannot tell
   "মাল কেনা" from "মাল আনার ভাড়া" and does not try.
   =========================================================================== */

// Returns { error } or { expense }.
function validateExpense(body = {}) {
  const category = String(body.category ?? '').trim();
  if (!category) return { error: 'Expense head is required — e.g. Shop Rent, Electricity, Salary.' };
  if (category.length > 60) return { error: 'Expense head is too long (max 60 characters).' };

  // Zero is rejected here, unlike a sale's total_price: a zero expense is only
  // ever a blank form submitted by accident.
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { error: 'Amount must be a number greater than zero.' };
  }

  const note = String(body.note ?? '').trim() || null;
  if (note && note.length > 200) return { error: 'Note is too long (max 200 characters).' };

  const raw = String(body.date ?? '').trim();
  if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: 'Date must be a real calendar date.' };
  }
  // A future date is allowed on purpose — rent paid in advance is a real entry.
  const date = raw || todayLocal();

  return { expense: { category, amount, note, date } };
}

// API: Record an expense
app.post('/api/expenses', async (req, res) => {
  const { error, expense } = validateExpense(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const result = await run(
      `INSERT INTO expenses (category, amount, note, date, created_time) VALUES (?, ?, ?, ?, ?)`,
      [expense.category, expense.amount, expense.note, expense.date, nowLocalTime()]
    );
    res.json({ id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* API: Correct an expense.
   No 409 anywhere in this file's expense routes: `expenses` has no uniqueness
   constraint, and inventing one — same head, same day, same amount — would
   refuse the second cup of tea on the same afternoon. */
app.put('/api/expenses/:id', async (req, res) => {
  const { error, expense } = validateExpense(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const existing = await get(`SELECT id FROM expenses WHERE id = ?`, [Number(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'That expense no longer exists.' });

    // created_time is left alone: it records when the row was entered, which
    // correcting it later does not change.
    await run(
      `UPDATE expenses SET category = ?, amount = ?, note = ?, date = ? WHERE id = ?`,
      [expense.category, expense.amount, expense.note, expense.date, Number(req.params.id)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete an expense. Nothing references it, so there is nothing to cascade.
app.delete('/api/expenses/:id', async (req, res) => {
  try {
    const result = await run(`DELETE FROM expenses WHERE id = ?`, [Number(req.params.id)]);
    if (result.changes === 0) return res.status(404).json({ error: 'That expense no longer exists.' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ===========================================================================
   Money receipt payments

   The only write path to an invoice, and it touches one column. A due receipt
   becomes a paid one by having its paid_amount raised to the invoice total —
   the customer settling up weeks later is an edit to the receipt already
   issued, not a new document, so the Invoice No. the customer holds keeps
   meaning what it meant.

   Nothing else on an invoice is editable here: changing the customer, the date
   or the lines after a receipt has been handed over is a different decision,
   and this route deliberately cannot make it.
   =========================================================================== */
app.put('/api/invoices/:id/payment', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid invoice.' });

  try {
    // Summed from the lines and returns, never taken from the request: the
    // client's idea of the total is exactly what the ceiling below has to be
    // checked against.
    const money = await invoiceMoney({ get }, id);
    if (!money) return res.status(404).json({ error: 'That invoice no longer exists.' });

    /* paid_amount is everything the customer has handed over, refunds not
       taken off — so after a return its ceiling is the new total plus what
       was already given back. The client sends it on that footing. */
    const ceiling = money.net + money.refunded;
    const { error, paid_amount } = validatePaidAmount(req.body?.paid_amount, ceiling);
    if (error) return res.status(400).json({ error });

    await run(`UPDATE invoices SET paid_amount = ? WHERE id = ?`, [paid_amount, id]);
    res.json({ id, paid_amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* On Vercel the platform imports this module and calls the exported handler per
   request — there is no long-running process to listen on a port, and calling
   listen() there would bind nothing and confuse the build. Locally there is no
   VERCEL variable, so the shop's PC still gets an ordinary server. */
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

export default app;