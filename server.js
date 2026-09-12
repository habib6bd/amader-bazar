import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// Override with PORT=… to run a second instance (a test copy, say) alongside
// the one the shop is using.
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
// Resolved against this file, not the current working directory — otherwise
// starting the server from elsewhere silently creates a second, empty database.
const db = new sqlite3.Database(path.join(__dirname, 'shop.db'), (err) => {
  if (err) console.error('Error opening database', err.message);
  else console.log('Connected to the SQLite database.');
});

/* ---------------------------------------------------------------------------
   Promise wrappers.

   node-sqlite3 defaults to *parallelize* mode: statements issued independently
   may be dispatched to the thread pool concurrently, and only those issued
   inside a db.serialize() window are ordered. Awaiting each statement enforces
   issue order regardless of mode, which the migration below depends on.

   Used by the migration and the newer routes. The original callback-style
   routes are left as they are — rewriting them is unrelated risk.
   --------------------------------------------------------------------------- */

// `function`, not an arrow: sqlite3 binds this.lastID / this.changes to it.
const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

/* Local wall-clock time as HH:MM, 24-hour — the format fmtTime() on the client
   already parses, and what every existing row uses.

   Deliberately local, not UTC. Date#getHours() reads the host's timezone, and
   the host is the shop's own PC. toISOString() or SQLite's datetime('now')
   would return UTC, and in Bangladesh (UTC+6) a 3pm sale would print as 09:00 —
   the same trap todayLocal() warns about on the client, six hours wide. If the
   server ever moves off the shop counter, set TZ=Asia/Dhaka for the process. */
function nowLocalTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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
}

// Create Tables & Seed Admin
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    cost_price REAL NOT NULL,
    selling_price REAL NOT NULL,
    barcode TEXT,
    warranty_months INTEGER NOT NULL DEFAULT 0
  )`);

  // `sale_time` rather than `time`, because TIME is an SQL function name.
  // `warranty_months` is snapshotted from the product at the moment of sale —
  // see POST /api/sales — so editing a product later never rewrites an invoice
  // that has already been issued.
  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    customer_contact TEXT,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_price REAL NOT NULL,
    date TEXT NOT NULL,
    sale_time TEXT,
    warranty_months INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS dealer_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealer_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_cost REAL NOT NULL,
    date TEXT NOT NULL
  )`);

  // Persistent Admin Table
  db.run(`CREATE TABLE IF NOT EXISTS admin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    password TEXT NOT NULL
  )`);

  // Seed default admin if table is empty
  db.get(`SELECT COUNT(*) as count FROM admin`, (err, row) => {
    if (row && row.count === 0) {
      db.run(`INSERT INTO admin (email, password) VALUES (?, ?)`, ["shop@admin.com", "admin123"]);
    }
  });
});

// The CREATE TABLEs above are queued inside the serialize() window, so they are
// issued before migrate()'s first statement; from there `await` keeps order. A
// request arriving mid-migration queues on the same connection and lands after.
migrate().catch((err) => console.error('Migration failed:', err.message));

// API: Login Endpoint (Database-backed)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  db.get(`SELECT * FROM admin WHERE email = ? AND password = ?`, [email, password], (err, row) => {
    if (row) {
      res.json({ success: true, message: "Login successful" });
    } else {
      res.status(401).json({ success: false, message: "Invalid email or password" });
    }
  });
});

// API: Password Reset Endpoint (Database-backed & Persistent)
app.post('/api/reset-password', (req, res) => {
  const { email, new_password } = req.body;
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ success: false, message: "Password must be at least 4 characters long" });
  }

  db.get(`SELECT * FROM admin WHERE email = ?`, [email], (err, row) => {
    if (row) {
      db.run(`UPDATE admin SET password = ? WHERE email = ?`, [new_password, email], (updateErr) => {
        if (updateErr) {
          res.status(500).json({ success: false, message: "Database error" });
        } else {
          res.json({ success: true, message: "Password updated successfully" });
        }
      });
    } else {
      res.status(404).json({ success: false, message: "Email not recognized as shop admin" });
    }
  });
});

// API: Get Dashboard Stats & Lists
app.get('/api/data', (req, res) => {
  db.all("SELECT * FROM inventory ORDER BY item_name COLLATE NOCASE", [], (invErr, inventory) => {
    if (invErr) return res.status(500).json({ error: invErr.message });

    db.all("SELECT * FROM sales ORDER BY id DESC", [], (salesErr, sales) => {
      if (salesErr) return res.status(500).json({ error: salesErr.message });

      db.all("SELECT * FROM dealer_purchases ORDER BY id DESC", [], (purchErr, purchases) => {
        if (purchErr) return res.status(500).json({ error: purchErr.message });

        res.json({ inventory, sales, purchases });
      });
    });
  });
});

// API: Record a Sale (Customer)
//
// The time of sale is stamped here, not sent by the browser. The form used to
// carry a time field pre-filled when the page loaded, which went stale the
// moment the dashboard sat open — open at 9am, sell at 3pm, invoice said 09:00.
// A client value is ignored outright rather than used as a fallback: the browser
// is the untrustworthy source here, and a PC with a wrong clock should not be
// able to stamp an invoice.
app.post('/api/sales', async (req, res) => {
  const { customer_name, customer_contact, item_name, quantity, total_price, date } = req.body;

  try {
    const result = await run(
      `INSERT INTO sales (customer_name, customer_contact, item_name, quantity, total_price, date, sale_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        customer_name,
        customer_contact || null,
        item_name,
        quantity,
        total_price,
        date,
        nowLocalTime(),
      ]
    );
    const saleId = result.lastID;

    // Matches on the exact item_name; a name that is not in stock silently
    // decrements nothing, which is long-standing behaviour (see README).
    await run(`UPDATE inventory SET quantity = quantity - ? WHERE item_name = ?`, [
      quantity,
      item_name,
    ]);

    res.json({ id: saleId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API: Record Dealer Purchase
app.post('/api/dealer', (req, res) => {
  const { dealer_name, item_name, quantity, total_cost, date } = req.body;

  db.run(
    `INSERT INTO dealer_purchases (dealer_name, item_name, quantity, total_cost, date) VALUES (?, ?, ?, ?, ?)`,
    [dealer_name, item_name, quantity, total_cost, date],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });

      db.get(`SELECT * FROM inventory WHERE item_name = ?`, [item_name], (err, row) => {
        if (row) {
          db.run(`UPDATE inventory SET quantity = quantity + ? WHERE item_name = ?`, [quantity, item_name], () => {
            res.json({ id: this.lastID });
          });
        } else {
          const unitCost = total_cost / quantity;
          db.run(`INSERT INTO inventory (item_name, quantity, cost_price, selling_price) VALUES (?, ?, ?, ?)`, 
            [item_name, quantity, unitCost, unitCost * 1.2], () => {
            res.json({ id: this.lastID });
          });
        }
      });
    }
  );
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});