/* NetBazar — dashboard logic (Alpine.js component).
   Loaded after shop-config.js and before alpine.min.js, so both SHOP and
   shopApp() exist when Alpine boots. */

// Stock at or below this count is flagged as low.
const LOW_STOCK_THRESHOLD = 5;

// How many sales/purchases rows to show before "Load more".
const PAGE_SIZE = 25;

// Local calendar date as YYYY-MM-DD. Deliberately not toISOString(), which is
// UTC — in Bangladesh (UTC+6) that returns yesterday's date until 6am.
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ---------------------------------------------------------------- numbers
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

// 0–99 in words.
function twoDigitWords(n) {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

// 0–999 in words.
function threeDigitWords(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const parts = [];
  if (hundreds) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest) parts.push(twoDigitWords(rest));
  return parts.join(' ');
}

// Whole taka in words on the South Asian scale — crore and lakh rather than
// million and billion — because that is how an invoice reads here.
function integerWords(n) {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  const parts = [];
  if (crore) parts.push(`${integerWords(crore)} Crore`);
  if (lakh) parts.push(`${threeDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigitWords(thousand)} Thousand`);
  if (rest) parts.push(threeDigitWords(rest));
  return parts.join(' ');
}

// Remembers that the user got past the login screen. localStorage rather than
// sessionStorage so it survives closing the tab, not just a refresh.
//
// NOTE: this is a UI convenience, not authentication. The server issues no
// session and the /api routes check nothing, so this flag only decides which
// screen to show. It gets replaced by a real session cookie when auth is done.
const SESSION_KEY = 'shop-session';

// Storage access throws outright in some contexts (private windows, browsers
// set to block site data), so never let it take the app down.
function readSession() {
  try {
    return localStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSession(active) {
  try {
    if (active) localStorage.setItem(SESSION_KEY, '1');
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to do — the user just logs in again next visit */
  }
}

// The form collects a price per unit, matching the invoice's "Price/ Unit"
// column; the amount is derived from it rather than typed twice.
//
// No sale_time here on purpose — the server stamps it at the moment of insert.
// A value seeded on the client would be the time the form was created, not the
// time of the sale.
function blankSale() {
  return {
    customer_name: '',
    customer_contact: '',
    item_name: '',
    quantity: '',
    unit_price: '',
    date: todayLocal(),
  };
}

function blankDealer() {
  return { dealer_name: '', item_name: '', quantity: '', total_cost: '', date: todayLocal() };
}

function shopApp() {
  return {
    // ---------------------------------------------------------------- auth
    isLoggedIn: false,
    authView: 'login',
    loginEmail: '',
    loginPassword: '',
    loginError: '',
    showLoginPassword: false,
    loggingIn: false,

    resetEmail: '',
    newPassword: '',
    resetError: '',
    resetSuccess: '',
    showResetPassword: false,
    resetting: false,

    // Shop identity — name, address, contacts. See js/shop-config.js.
    shop: window.SHOP,

    // ------------------------------------------------------------ dashboard
    activeForm: 'sale',
    inventory: [],
    sales: [],
    purchases: [],
    loading: false,
    loadError: '',

    invSearch: '',
    saleSearch: '',
    dealerSearch: '',
    salesLimit: PAGE_SIZE,
    purchasesLimit: PAGE_SIZE,

    sale: blankSale(),
    dealer: blankDealer(),
    savingSale: false,
    savingDealer: false,

    isReceiptOpen: false,
    currentReceipt: {},
    baseTitle: document.title,

    toast: { show: false, message: '', type: 'success' },
    toastTimer: null,

    init() {
      // Survive a refresh, a new tab, and a browser restart instead of
      // bouncing back to the login screen.
      if (readSession()) {
        this.isLoggedIn = true;
        this.loadData();
      }
      // Restore the tab title after the print/save-as-PDF dialog closes.
      window.addEventListener('afterprint', () => {
        document.title = this.baseTitle;
      });
    },

    // ------------------------------------------------------------- helpers
    today: todayLocal,

    fmt(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '৳ 0.00';
      return (
        '৳ ' +
        v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      );
    },

    fmtDate(d) {
      if (!d) return '—';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const dt = new Date(`${d}T00:00:00`);
      if (Number.isNaN(dt.getTime())) return d;
      return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    },

    // Plain number, no currency mark — the invoice's amount columns carry the
    // taka sign once in the header instead of on every row.
    fmtNum(n) {
      const v = Number(n);
      if (!Number.isFinite(v)) return '0.00';
      return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    // DD-MM-YYYY, the format the printed invoice uses.
    fmtDateDMY(d) {
      if (!d) return '—';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
      const [y, m, day] = d.split('-');
      return `${day}-${m}-${y}`;
    },

    // "16:02" -> "04:02 PM". Sales recorded before the invoice redesign have
    // no time stored, so they print an em dash rather than a made-up one.
    fmtTime(t) {
      if (!t) return '—';
      const match = /^(\d{1,2}):(\d{2})/.exec(t);
      if (!match) return t;
      const hours = Number(match[1]);
      if (!Number.isFinite(hours) || hours > 23) return t;
      const suffix = hours >= 12 ? 'PM' : 'AM';
      const hour12 = hours % 12 || 12;
      return `${String(hour12).padStart(2, '0')}:${match[2]} ${suffix}`;
    },

    // Price per unit. Stored sales keep the total, so older rows — and any row
    // whose total was edited directly in the database — still show a sensible
    // per-unit figure.
    unitPrice(row) {
      const qty = Number(row?.quantity);
      const total = Number(row?.total_price);
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(total)) return 0;
      return total / qty;
    },

    // Amount spelled out under the totals, as invoices here are expected to.
    amountInWords(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v < 0) return '—';
      const taka = Math.floor(v);
      // Rounded, not truncated, so 0.999 reads as one taka rather than 99 paisa.
      const paisa = Math.round((v - taka) * 100);
      if (paisa === 100) return `${integerWords(taka + 1)} Taka Only`;
      const words = `${integerWords(taka)} Taka`;
      return paisa ? `${words} and ${twoDigitWords(paisa)} Paisa Only` : `${words} Only`;
    },

    notify(message, type = 'success') {
      this.toast = { show: true, message, type };
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toast.show = false;
      }, 3500);
    },

    // Live "Amount" preview under the sale form, and the figure actually
    // saved as the sale total.
    get saleAmount() {
      const qty = Number(this.sale.quantity);
      const unit = Number(this.sale.unit_price);
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
      return qty * unit;
    },

    // -------------------------------------------------------- derived stats
    get todaysSales() {
      const t = todayLocal();
      return this.sales.filter((s) => s.date === t);
    },

    get todaysRevenue() {
      return this.todaysSales.reduce((sum, s) => sum + Number(s.total_price || 0), 0);
    },

    get totalRevenue() {
      return this.sales.reduce((sum, s) => sum + Number(s.total_price || 0), 0);
    },

    get dealerSpend() {
      return this.purchases.reduce((sum, p) => sum + Number(p.total_cost || 0), 0);
    },

    get lowStockItems() {
      return this.inventory.filter((i) => Number(i.quantity) < LOW_STOCK_THRESHOLD);
    },

    isLowStock(item) {
      return Number(item.quantity) < LOW_STOCK_THRESHOLD;
    },

    // ------------------------------------------------------ filtered lists
    get filteredInventory() {
      const q = this.invSearch.trim().toLowerCase();
      if (!q) return this.inventory;
      return this.inventory.filter((i) => (i.item_name || '').toLowerCase().includes(q));
    },

    get filteredSales() {
      const q = this.saleSearch.trim().toLowerCase();
      if (!q) return this.sales;
      return this.sales.filter(
        (s) =>
          (s.customer_name || '').toLowerCase().includes(q) ||
          (s.item_name || '').toLowerCase().includes(q)
      );
    },

    get visibleSales() {
      return this.filteredSales.slice(0, this.salesLimit);
    },

    get filteredPurchases() {
      const q = this.dealerSearch.trim().toLowerCase();
      if (!q) return this.purchases;
      return this.purchases.filter(
        (p) =>
          (p.dealer_name || '').toLowerCase().includes(q) ||
          (p.item_name || '').toLowerCase().includes(q)
      );
    },

    get visiblePurchases() {
      return this.filteredPurchases.slice(0, this.purchasesLimit);
    },

    // ---------------------------------------------------------------- auth
    async login() {
      if (this.loggingIn) return;
      this.loggingIn = true;
      this.loginError = '';
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.loginEmail, password: this.loginPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          this.isLoggedIn = true;
          writeSession(true);
          this.loginPassword = '';
          this.loadData();
        } else {
          this.loginError = data.message || 'Invalid email or password';
        }
      } catch (err) {
        this.loginError = 'Connection error. Try again.';
      } finally {
        this.loggingIn = false;
      }
    },

    logout() {
      writeSession(false);
      this.isLoggedIn = false;
      this.isReceiptOpen = false;
      this.loginEmail = '';
      this.loginPassword = '';
    },

    async resetPassword() {
      if (this.resetting) return;
      this.resetting = true;
      try {
        const res = await fetch('/api/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: this.resetEmail, new_password: this.newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          this.resetSuccess = 'Password updated. You can log in now.';
          this.resetError = '';
          setTimeout(() => {
            this.authView = 'login';
            this.newPassword = '';
          }, 1800);
        } else {
          this.resetError = data.message || 'Could not update the password.';
          this.resetSuccess = '';
        }
      } catch (err) {
        this.resetError = 'Connection error. Try again.';
      } finally {
        this.resetting = false;
      }
    },

    // ---------------------------------------------------------------- data
    async loadData() {
      this.loading = true;
      this.loadError = '';
      try {
        const res = await fetch('/api/data');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load shop data.');
        this.inventory = data.inventory || [];
        this.sales = data.sales || [];
        this.purchases = data.purchases || [];
      } catch (err) {
        this.loadError = err.message || 'Could not load shop data.';
        this.notify(this.loadError, 'error');
      } finally {
        this.loading = false;
      }
    },

    async submitSale() {
      if (this.savingSale) return;
      this.savingSale = true;
      try {
        const res = await fetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // total_price stays the stored figure; the form's unit price is
          // what the shopkeeper types, so it is multiplied out here.
          // sale_time is absent deliberately — the server stamps it.
          body: JSON.stringify({
            customer_name: this.sale.customer_name,
            customer_contact: this.sale.customer_contact,
            item_name: this.sale.item_name,
            quantity: this.sale.quantity,
            total_price: this.saleAmount,
            date: this.sale.date,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save the sale.');

        await this.loadData();
        this.sale = blankSale();
        this.notify('Sale saved — invoice ready.');

        // The button promises an invoice, so actually open one.
        const row = this.sales.find((s) => s.id === data.id);
        if (row) this.showReceipt(row);
      } catch (err) {
        this.notify(err.message || 'Could not save the sale.', 'error');
      } finally {
        this.savingSale = false;
      }
    },

    async submitDealer() {
      if (this.savingDealer) return;
      this.savingDealer = true;
      try {
        const res = await fetch('/api/dealer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.dealer),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not save the purchase.');

        await this.loadData();
        this.dealer = blankDealer();
        this.notify('Dealer purchase saved — stock updated.');
      } catch (err) {
        this.notify(err.message || 'Could not save the purchase.', 'error');
      } finally {
        this.savingDealer = false;
      }
    },

    // ------------------------------------------------------- receipt/print
    showReceipt(item) {
      this.currentReceipt = item;
      this.isReceiptOpen = true;
    },

    closeReceipt() {
      this.isReceiptOpen = false;
      document.title = this.baseTitle;
    },

    // Filename the browser suggests in the print dialog's Save-as-PDF flow.
    receiptFilename() {
      const name = (this.currentReceipt.customer_name || 'invoice')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
      const invoiceNo = this.currentReceipt.id ?? '';
      const date = this.currentReceipt.date || todayLocal();
      return `NetBazar-Invoice-${invoiceNo}-${name || 'customer'}-${date}`;
    },

    // Wait for Alpine to render and for the modal transition to settle before
    // opening the dialog. The old code guessed with setTimeout(300) and could
    // capture the receipt mid-fade.
    async printReceipt(item) {
      if (item) this.showReceipt(item);
      await this.$nextTick();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      document.title = this.receiptFilename();
      window.print();
    },
  };
}

window.shopApp = shopApp;
