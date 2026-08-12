import express from 'express';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const db = new sqlite3.Database('./shop.db', (err) => {
  if (err) console.error('Error opening database', err.message);
  else console.log('Connected to the SQLite database.');
});

// Create Tables & Seed Admin
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    cost_price REAL NOT NULL,
    selling_price REAL NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    total_price REAL NOT NULL,
    date TEXT NOT NULL
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
  db.all("SELECT * FROM inventory", [], (err, inventory) => {
    db.all("SELECT * FROM sales ORDER BY id DESC", [], (err, sales) => {
      db.all("SELECT * FROM dealer_purchases ORDER BY id DESC", [], (err, purchases) => {
        res.json({ inventory, sales, purchases });
      });
    });
  });
});

// API: Record a Sale (Customer)
app.post('/api/sales', (req, res) => {
  const { customer_name, item_name, quantity, total_price, date } = req.body;
  
  db.run(
    `INSERT INTO sales (customer_name, item_name, quantity, total_price, date) VALUES (?, ?, ?, ?, ?)`,
    [customer_name, item_name, quantity, total_price, date],
    function(err) {
      if (err) return res.status(400).json({ error: err.message });
      
      const saleId = this.lastID;
      db.run(`UPDATE inventory SET quantity = quantity - ? WHERE item_name = ?`, [quantity, item_name], () => {
        res.json({ id: saleId });
      });
    }
  );
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