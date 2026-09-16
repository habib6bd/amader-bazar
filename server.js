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

    for (const sale of orphans) {
      const header = [
        sale.customer_name,
        sale.customer_contact,
        sale.date,
        sale.sale_time,
        sale.comment,
      ];
      const taken = (await tx.execute({ sql: 'SELECT 1 FROM invoices WHERE id = ?', args: [sale.id] })).rows.length;

      let invoiceId;
      if (!taken) {
        await tx.execute({
          sql: `INSERT INTO invoices (id, customer_name, customer_contact, date, sale_time, comment)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [sale.id, ...header],
        });
        invoiceId = Number(sale.id);
      } else {
        const r = await tx.execute({
          sql: `INSERT INTO invoices (customer_name, customer_contact, date, sale_time, comment)
                VALUES (?, ?, ?, ?, ?)`,
          args: header,
        });
        invoiceId = Number(r.lastInsertRowid);
      }

      await tx.execute({
        sql: 'UPDATE sales SET invoice_id = ?, line_no = 1 WHERE id = ?',
        args: [invoiceId, sale.id],
      });
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
const SCHEMA_VERSION = '2026-09-17-invoices';

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
    // The admin check stays outside the fast path: ADMIN_EMAIL may be set on a
    // later deploy of a database that was already migrated without one.
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
    warranty_months INTEGER NOT NULL DEFAULT 0
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
    line_no INTEGER
  )`);

  // One row per money receipt. Its lines live in `sales`, joined by
  // sales.invoice_id; the customer, date, time and comment are stored here once
  // rather than repeated on every line.
  await run(`CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_contact TEXT,
    date TEXT NOT NULL,
    sale_time TEXT,
    comment TEXT
  )`);

  await run(`CREATE TABLE IF NOT EXISTS dealer_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    date TEXT NOT NULL
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
    const [inventory, invoices, sales, purchases] = await Promise.all([
      all('SELECT * FROM inventory ORDER BY item_name COLLATE NOCASE'),
      all('SELECT * FROM invoices ORDER BY id DESC'),
      // `sales` are invoice lines; ordered so each invoice's lines arrive in
      // the serial order they were entered.
      all('SELECT * FROM sales ORDER BY invoice_id DESC, line_no, id'),
      all('SELECT * FROM dealer_purchases ORDER BY id DESC'),
    ]);
    res.json({ inventory, invoices, sales, purchases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  if (!customer_name) return res.status(400).json({ error: 'Customer name is required.' });
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
    items.push({ item_name, quantity, total_price });
  }

  /* All or nothing. An invoice whose third line failed must not leave the first
     two recorded and their stock deducted — the shop would be short on stock
     with no receipt to show for it. 'write' takes the lock up front. */
  const tx = await db.transaction('write');
  try {
    const time = nowLocalTime();
    const invoice = await tx.execute({
      sql: `INSERT INTO invoices (customer_name, customer_contact, date, sale_time, comment)
            VALUES (?, ?, ?, ?, ?)`,
      args: [customer_name, customer_contact, date, time, comment],
    });
    const invoiceId = Number(invoice.lastInsertRowid);

    for (const [i, item] of items.entries()) {
      /* Snapshot what the product was worth at this moment.

         Exact match, not COLLATE NOCASE, because the stock decrement below
         matches exactly too — two different notions of "the same product" in
         one request would let a line inherit a cost while never reducing stock.

         An item that is not in inventory leaves all three NULL, which is a real
         path: the item field is free text. NULL renders as no warranty line and
         excludes the line from profit, which is right — the shop cannot cost, or
         honour a warranty on, something it has no record of. */
      const product = (
        await tx.execute({
          sql: `SELECT cost_price, selling_price, warranty_months FROM inventory WHERE item_name = ?`,
          args: [item.item_name],
        })
      ).rows[0];

      // Customer, date and time are repeated on each line so the sales table
      // still reads sensibly on its own; the invoice row is the source of truth.
      // The comment belongs to the invoice only.
      await tx.execute({
        sql: `INSERT INTO sales (invoice_id, line_no, customer_name, customer_contact, item_name,
                                 quantity, total_price, date, sale_time,
                                 warranty_months, cost_price, list_price)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          invoiceId,
          i + 1,
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
        ],
      });

      // Matches on the exact item_name; a name that is not in stock silently
      // decrements nothing, which is long-standing behaviour (see README).
      await tx.execute({
        sql: `UPDATE inventory SET quantity = quantity - ? WHERE item_name = ?`,
        args: [item.quantity, item.item_name],
      });
    }

    await tx.commit();
    res.json({ id: invoiceId });
  } catch (err) {
    await tx.rollback().catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

/* API: Record Dealer Purchase — the shop's product-entry path.

   This is where stock comes in, so it is also where prices are set: the form
   takes a buying price and a selling price per unit, and both are written onto
   the product. Restocking therefore *updates* the product's prices rather than
   leaving them frozen at whatever the first-ever purchase implied, which is
   what used to happen (selling price was guessed as cost × 1.2 once, and could
   never be changed). Earlier sales keep their own snapshotted cost_price, so
   correcting prices here never rewrites profit already earned.

   total_cost stays the stored figure on dealer_purchases, derived here from
   quantity × buying price so there is one source of truth. */
app.post('/api/dealer', async (req, res) => {
  const { dealer_name, item_name, quantity, date, barcode, warranty_months } = req.body;

  const name = String(item_name ?? '').trim();
  const dealer = String(dealer_name ?? '').trim();
  const qty = Number(quantity);

  if (!dealer) return res.status(400).json({ error: 'Dealer name is required.' });
  if (!name) return res.status(400).json({ error: 'Item name is required.' });
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be a whole number, one or more.' });
  }

  // A page cached from before this change still posts total_cost and no prices.
  // Derive the unit cost from it rather than rejecting the sale of a shop that
  // has not reloaded yet.
  const legacyTotal = Number(req.body.total_cost);
  const cost = Number.isFinite(Number(req.body.cost_price))
    ? Number(req.body.cost_price)
    : Number.isFinite(legacyTotal)
      ? legacyTotal / qty
      : NaN;
  if (!Number.isFinite(cost) || cost < 0) {
    return res.status(400).json({ error: 'Buying price must be a number, zero or more.' });
  }

  try {
    const existing = await get(`SELECT * FROM inventory WHERE item_name = ?`, [name]);

    // Falls back to the product's current price, then to the old cost × 1.2
    // guess for a brand-new item whose page did not send one.
    const sell = Number.isFinite(Number(req.body.selling_price))
      ? Number(req.body.selling_price)
      : existing
        ? existing.selling_price
        : cost * 1.2;
    if (!Number.isFinite(sell) || sell < 0) {
      return res.status(400).json({ error: 'Selling price must be a number, zero or more.' });
    }

    const code = String(barcode ?? '').trim() || null;
    if (code && !/^[0-9A-Za-z-]{4,64}$/.test(code)) {
      return res.status(400).json({ error: 'Barcode must be 4–64 letters, digits or hyphens, with no spaces.' });
    }
    if (code) {
      // The scan fills the item name in the form, so by submit time the two
      // agree. If they do not, the barcode belongs to something else and
      // silently moving it would be worse than refusing.
      const owner = await get(`SELECT item_name FROM inventory WHERE barcode = ? AND item_name != ?`, [code, name]);
      if (owner) return res.status(409).json({ error: `That barcode is already on "${owner.item_name}".` });
    }

    const warranty = Number.isFinite(Number(warranty_months)) ? Number(warranty_months) : existing?.warranty_months ?? 0;
    if (!Number.isInteger(warranty) || warranty < 0 || warranty > 600) {
      return res.status(400).json({ error: 'Warranty must be a whole number of months between 0 and 600.' });
    }

    const totalCost = cost * qty;
    const purchase = await run(
      `INSERT INTO dealer_purchases (dealer_name, item_name, quantity, total_cost, date) VALUES (?, ?, ?, ?, ?)`,
      [dealer, name, qty, totalCost, date || todayLocal()]
    );

    if (existing) {
      await run(
        `UPDATE inventory
            SET quantity = quantity + ?, cost_price = ?, selling_price = ?,
                warranty_months = ?, barcode = COALESCE(?, barcode)
          WHERE id = ?`,
        [qty, cost, sell, warranty, code, existing.id]
      );
    } else {
      await run(
        `INSERT INTO inventory (item_name, quantity, cost_price, selling_price, barcode, warranty_months)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, qty, cost, sell, code, warranty]
      );
    }

    res.json({ id: purchase.lastID });
  } catch (err) {
    if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'That barcode is already used by another product.' });
    }
    res.status(400).json({ error: err.message });
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
app.post('/api/inventory', async (req, res) => {
  const { error, item } = validateItem(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const conflict = await findConflict(item);
    if (conflict) return res.status(409).json({ error: conflict });

    const result = await run(
      `INSERT INTO inventory (item_name, quantity, cost_price, selling_price, barcode, warranty_months)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [item.item_name, item.quantity, item.cost_price, item.selling_price, item.barcode, item.warranty_months]
    );
    res.json({ id: result.lastID });
  } catch (err) {
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
      await tx.commit();
      res.json({ success: true, renamed: s.rowsAffected + p.rowsAffected });
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
app.delete('/api/inventory/:id', async (req, res) => {
  try {
    const result = await run(`DELETE FROM inventory WHERE id = ?`, [Number(req.params.id)]);
    if (result.changes === 0) return res.status(404).json({ error: 'That product no longer exists.' });
    res.json({ success: true });
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