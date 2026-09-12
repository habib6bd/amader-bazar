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
  // warranty_months, cost_price and list_price are all snapshotted from the
  // product at the moment of sale — see POST /api/sales — so editing a product
  // later never rewrites an invoice already issued, nor the profit already made.
  db.run(`CREATE TABLE IF NOT EXISTS sales (
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
    comment TEXT
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
  const { customer_name, customer_contact, item_name, quantity, total_price, date, comment } = req.body;

  try {
    /* Snapshot what the product was worth at this moment.

       Exact match, not COLLATE NOCASE, because the stock decrement below
       matches exactly too — two different notions of "the same product" in one
       request would let a sale inherit a cost while never reducing stock.

       An item that is not in inventory leaves all three NULL, which is a real
       path: the item field is free text. NULL renders as no warranty line and
       excludes the sale from profit, which is right — the shop cannot cost, or
       honour a warranty on, something it has no record of. */
    const product = await get(
      `SELECT cost_price, selling_price, warranty_months FROM inventory WHERE item_name = ?`,
      [item_name]
    );

    const result = await run(
      `INSERT INTO sales (customer_name, customer_contact, item_name, quantity, total_price,
                          date, sale_time, warranty_months, cost_price, list_price, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer_name,
        customer_contact || null,
        item_name,
        quantity,
        total_price,
        date,
        nowLocalTime(),
        product ? product.warranty_months : null,
        product ? product.cost_price : null,
        product ? product.selling_price : null,
        String(comment ?? '').trim() || null,
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
      [dealer, name, qty, totalCost, date]
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

       BEGIN IMMEDIATE, not plain BEGIN: it takes the write lock up front, so
       the transaction cannot fail at COMMIT time after partial work. */
    await run('BEGIN IMMEDIATE');
    try {
      await run(updateItem, fields);
      const s = await run(`UPDATE sales SET item_name = ? WHERE item_name = ?`, [item.item_name, oldName]);
      const p = await run(`UPDATE dealer_purchases SET item_name = ? WHERE item_name = ?`, [item.item_name, oldName]);
      await run('COMMIT');
      res.json({ success: true, renamed: s.changes + p.changes });
    } catch (txErr) {
      await run('ROLLBACK').catch(() => {});
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});