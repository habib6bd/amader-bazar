/* NetBazar — dashboard logic (Alpine.js component).
   Loaded after shop-config.js and before alpine.min.js, so both SHOP and
   shopApp() exist when Alpine boots. */

// Stock at or below this count is flagged as low.
const LOW_STOCK_THRESHOLD = 5;

// Rows a long table shows before it is expanded. Small on purpose: the till is
// used on a laptop at a counter, and a shop with a hundred products should not
// have to scroll past all of them to reach the next section.
const ROWS_COLLAPSED = 5;

// Below this, a remaining balance is float noise rather than money owed. Must
// match PAID_EPSILON in server.js, which validates the paid amount the same way.
const PAID_EPSILON = 0.005;

// Local calendar date as YYYY-MM-DD. Deliberately not toISOString(), which is
// UTC — in Bangladesh (UTC+6) that returns yesterday's date until 6am.
function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* The dates a preset covers, as YYYY-MM-DD strings. Shared by setDateRange()
   and the activePreset getter, so the buttons and the highlight can never
   disagree about what "This Week" means. Built from local date parts, never
   toISOString() — see todayLocal() above. */
function rangeFor(preset) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;

  if (preset === 'today') return { from: iso(d), to: iso(d) };

  if (preset === 'week') {
    // Week starts Saturday, as the Bangladeshi working week does.
    const start = new Date(d);
    start.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return { from: iso(start), to: iso(d) };
  }

  if (preset === 'month') {
    return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: iso(d) };
  }

  return { from: '', to: '' }; // 'all'
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

/* Remembers that the browser believes it is signed in, so a refresh does not
   flash the login screen before the server answers. localStorage rather than
   sessionStorage so it survives closing the tab.

   This is a *hint*, not authentication. The real session is an httpOnly cookie
   the page cannot read, and every /api route is checked server-side — clearing
   or forging this flag gets you an empty dashboard and a string of 401s, not
   access to anything. init() confirms it against /api/session on load. */
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

/* Which dashboard sections are open, remembered per browser so the layout a
   shopkeeper settles on survives a refresh. Purely cosmetic: losing it costs
   nothing, which is why every access is wrapped rather than guarded. */
const SECTIONS_KEY = 'shop-sections';
const DEFAULT_SECTIONS = { products: true, serials: true, sales: true, expenses: true, purchases: true };

function readSections() {
  try {
    return { ...DEFAULT_SECTIONS, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SECTIONS };
  }
}

function writeSections(sections) {
  try {
    localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections));
  } catch {
    /* nothing to do — the sections simply open again next visit */
  }
}

// The invoice header. Items live in the cart, one entry per line.
//
// No sale_time here on purpose — the server stamps it at the moment of insert.
// A value seeded on the client would be the time the form was created, not the
// time of the sale.
/* `paid_amount` blank means the customer paid in full — submitSale() sends the
   cart total for it. The ordinary cash sale is the common one and should cost
   no typing; a credit sale is where the shopkeeper stops to enter a figure. */
function blankSale() {
  return {
    customer_name: '',
    customer_contact: '',
    date: todayLocal(),
    comment: '',
    paid_amount: '',
  };
}

// The "add an item" row above the cart. Price is per piece, matching the
// invoice's "Price/ Unit" column; the line amount is derived, never typed.
function blankLine() {
  return { item_name: '', quantity: 1, unit_price: '', serial_no: '' };
}

// The units scanned in on the Dealer form for one product, newest first.
// purchase_id is the dealer_purchases row the server grows with each scan.
function blankBatch() {
  return { purchase_id: null, item_name: '', units: [] };
}

/* Serial receiving is one POST per scan, and a scanner can fire the next scan
   before the last reply is back. Chaining them keeps them in order, which is
   what lets each scan carry the purchase id the one before it created.

   Module-level, not a component property: Alpine wraps component state in a
   reactive Proxy, and calling .then on a proxied Promise throws. */
let scanQueue = Promise.resolve();
function queueScan(task) {
  const next = scanQueue.then(task, task);
  scanQueue = next.catch(() => {});
  return next;
}

/* A short tone for each scan, so the cashier knows the result without looking
   up: one high beep for OK, two low ones for a refusal. Web Audio, no sound
   file to load; a browser that refuses audio simply stays silent. */
let audioCtx = null;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const tones = ok ? [[880, 0]] : [[220, 0], [220, 0.16]];
    for (const [freq, at] of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = freq;
      osc.type = ok ? 'sine' : 'square';
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      const start = audioCtx.currentTime + at;
      osc.start(start);
      osc.stop(start + 0.12);
    }
  } catch {
    /* no audio — the toast still says it */
  }
}

// Same code, case aside — how serials are compared everywhere, matching the
// server's COLLATE NOCASE index.
function sameCode(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/* Groups invoice lines under their invoices.

   The server sends both flat; doing the join once per load keeps every list and
   total that follows a simple walk over invoices, instead of re-grouping all
   lines on each render.

   A line that references no known invoice cannot occur after migration, but if
   one ever did it would silently vanish from the history — so it is shown as an
   invoice of its own instead. */
function buildInvoices(invoices, lines) {
  const byId = new Map();
  for (const inv of invoices) byId.set(Number(inv.id), { ...inv, key: `i${inv.id}`, lines: [] });

  const orphans = [];
  for (const line of lines) {
    const inv = byId.get(Number(line.invoice_id));
    if (inv) inv.lines.push(line);
    else orphans.push({ ...line, key: `o${line.id}`, lines: [line] });
  }

  const byLine = (a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0) || Number(a.id) - Number(b.id);
  const grouped = [...byId.values()].filter((inv) => inv.lines.length > 0);
  for (const inv of grouped) inv.lines.sort(byLine);

  return [...grouped, ...orphans].sort((a, b) => Number(b.id) - Number(a.id));
}

// Dealer purchases are how stock and prices both enter the shop, so the form
// carries the product's full detail, not just a total cost.
function blankDealer() {
  return {
    dealer_name: '',
    barcode: '',
    item_name: '',
    quantity: '',
    cost_price: '',
    selling_price: '',
    warranty_months: '',
    date: todayLocal(),
  };
}

/* One running cost. `category` is the খরচের খাত — free text, offered back as a
   suggestion next time. `amount` is the whole expense, not a unit price. */
function blankExpense() {
  return { id: null, category: '', amount: '', note: '', date: todayLocal() };
}

function blankProduct() {
  return {
    id: null,
    item_name: '',
    barcode: '',
    quantity: '',
    cost_price: '',
    selling_price: '',
    warranty_months: 0,
  };
}

/* Adds N months to a YYYY-MM-DD date, clamping to the end of the target month
   so 31 Jan + 1 month is 28 Feb (29 in a leap year) rather than spilling into
   March. Used for warranty expiry.

   new Date(y, mo, 0) is the last day of month `mo`: the constructor's month
   argument is 0-based, so `mo` names the *following* month and day 0 steps back
   one day from it. Leap years included, with no lookup table. Building from
   numbers also avoids the UTC parsing trap that todayLocal() warns about. */
function addMonths(dateStr, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  // Guarded against null explicitly: Number(null) is 0, which is finite, so a
  // missing warranty would otherwise return the sale date unchanged.
  if (!m || months == null || months === '') return '';
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0) return '';

  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (x) => String(x).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(Number(m[3]), lastDay))}`;
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

    // Change password (signed in only) — replaces the old public reset flow.
    isPasswordOpen: false,
    currentPassword: '',
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
    // Which money receipts the sales history lists: 'all' | 'due' | 'paid'.
    saleStatus: 'all',
    // Both start collapsed to five rows; "Show all" opens them fully.
    invLimit: ROWS_COLLAPSED,
    salesLimit: ROWS_COLLAPSED,
    expensesLimit: ROWS_COLLAPSED,
    purchasesLimit: ROWS_COLLAPSED,
    // Exposed so the markup can use the constant instead of repeating the
    // literal 5 — those copies do not follow when the constant changes.
    rowsCollapsed: ROWS_COLLAPSED,
    /* Two flat booleans rather than one `sections` object: Alpine tracks a
       change to a top-level property reliably, but a change to a key *inside* a
       nested object bound as `sections.products` was not picked up here — the
       value changed and the panel stayed open. Flat is also less to read. */
    productsOpen: readSections().products,
    salesOpen: readSections().sales,
    expensesOpen: readSections().expenses,
    purchasesOpen: readSections().purchases,

    sale: blankSale(),
    // The invoice being built: [{ key, item_name, quantity, unit_price, serial_no }].
    cart: [],
    line: blankLine(),
    cartSeq: 0,
    // Invoices with their lines attached — see buildInvoices().
    invoices: [],
    dealer: blankDealer(),
    savingSale: false,
    savingDealer: false,

    // Barcode scanning. A USB scanner types the code then presses Enter, so
    // there is no need to detect fast typing — see scanBarcode().
    scanCode: '',
    unknownBarcode: '',
    dealerScanCode: '',

    /* Serial scanning is the second half of a till scan: the product barcode
       says *what* was sold, the serial says *which piece*. serialTarget is the
       cart line the next scanned serial belongs to — the line just added — so
       the shopkeeper never has to point at a row. */
    serialCode: '',
    serialTarget: null,
    // An unregistered serial scanned for a tracked line, waiting on the
    // cashier's "Sell anyway": { code, key } or null.
    serialOverride: null,
    // The last code each scan box took, and when — see repeatScan().
    lastScan: {},

    // Dealer form, serial receiving — see scanDealerSerial().
    dealerSerialCode: '',
    dealerBatch: blankBatch(),

    // Product screen: the available serials of the product being edited.
    productSerials: [],
    productSerialCode: '',
    productSerialsLoading: false,

    // Serial / IMEI section. Fetched page by page from the server, never
    // shipped with /api/data — a year of phones is thousands of rows.
    serialsOpen: readSections().serials,
    serialQuery: '',
    serialStatus: 'all',
    serialProductId: '',
    serialRows: [],
    serialTotal: 0,
    serialLoading: false,
    serialLoaded: false,
    // History / return / remove dialog: { mode, row, events, note, error, saving, loading }.
    serialDialog: null,

    // Expenses — the form panel, the list, and the edit dialog.
    expenses: [],
    expense: blankExpense(),
    savingExpense: false,
    expenseSearch: '',
    isExpenseOpen: false,
    expenseDraft: blankExpense(),
    expenseError: '',
    savingExpenseEdit: false,
    confirmExpenseDelete: false,

    // Product manager
    isProductOpen: false,
    productMode: 'add',
    product: blankProduct(),
    savingProduct: false,
    productError: '',
    confirmDelete: false,

    /* Date filter, shared by the sales and expense lists so that
       net = profit − expenses is a true subtraction rather than two ranges
       compared by accident. Starts on today; setDateRange('all') clears both
       back to '', which means all time. */
    dateFrom: todayLocal(),
    dateTo: todayLocal(),

    isReceiptOpen: false,
    currentReceipt: {},
    baseTitle: document.title,

    /* Recording a payment against an invoice already issued. `paymentDraft`
       holds a copy, never the live invoice — see openPayment(). */
    isPaymentOpen: false,
    paymentDraft: { id: null, total: 0, paid_amount: '' },
    paymentError: '',
    savingPayment: false,

    toast: { show: false, message: '', type: 'success' },
    toastTimer: null,
    refreshTimer: null,

    async init() {
      // Restore the tab title after the print/save-as-PDF dialog closes.
      window.addEventListener('afterprint', () => {
        document.title = this.baseTitle;
      });

      // Show the dashboard immediately if this browser was signed in, so a
      // refresh does not flash the login card, then confirm with the server.
      // The cookie can have expired while the tab was closed, and only the
      // server knows that.
      if (readSession()) this.isLoggedIn = true;

      try {
        const res = await fetch('/api/session');
        const data = await res.json().catch(() => ({}));
        if (data.authenticated) {
          this.isLoggedIn = true;
          writeSession(true);
          this.loadData();
        } else {
          this.isLoggedIn = false;
          writeSession(false);
        }
      } catch {
        // Offline or the server is down. Keep whatever the local hint said and
        // let loadData surface the real error rather than logging the shop out
        // of a till that is working fine.
        if (this.isLoggedIn) this.loadData();
      }
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

    /* Turns a failed response into something the shopkeeper can act on.

       The case worth naming: if the server process is still running a build
       from before these routes existed, Express answers with an HTML 404 page.
       res.json() then throws, leaving no `error` field, and the old code fell
       back to a blank "could not save" that gave no clue the real fix was to
       restart the server. */
    async describeFailure(res, fallback) {
      const body = await res.text().catch(() => '');
      try {
        const data = JSON.parse(body);
        if (data && data.error) return data.error;
      } catch {
        /* not JSON — handled below */
      }
      if (res.status === 404 && /<!DOCTYPE|<html/i.test(body)) {
        return 'This server does not have the products API yet — restart the app on the shop PC, then try again.';
      }
      return `${fallback} (server said ${res.status})`;
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
    lineTotal(l) {
      const qty = Number(l?.quantity);
      const unit = Number(l?.unit_price);
      if (!Number.isFinite(qty) || !Number.isFinite(unit)) return 0;
      return qty * unit;
    },

    // Amount of the row being typed, before it is added.
    get lineAmount() {
      return this.lineTotal(this.line);
    },

    get cartTotal() {
      return this.cart.reduce((sum, l) => sum + this.lineTotal(l), 0);
    },

    get cartPieces() {
      return this.cart.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
    },

    /* What the customer would still owe on the invoice being built. The
       shopkeeper types only what was handed over; the due follows from it, and
       is shown before the receipt is printed rather than after. */
    get saleDue() {
      if (this.sale.paid_amount === '') return 0;
      const paid = Number(this.sale.paid_amount);
      if (!Number.isFinite(paid)) return 0;
      return Math.max(0, this.cartTotal - paid);
    },

    /* ------------------------------------------------------------- warranty */

    // "Warranty: 12 months (valid to 10-09-2027)", or '' when there is none.
    // Reads the sale's own snapshot, so editing the product later never changes
    // what an already-issued invoice says.
    warrantyText(row) {
      const n = Number(row?.warranty_months);
      if (!Number.isFinite(n) || n <= 0) return '';
      const unit = n === 1 ? 'month' : 'months';
      const until = addMonths(row.date, n);
      return until
        ? `Warranty: ${n} ${unit} (valid to ${this.fmtDateDMY(until)})`
        : `Warranty: ${n} ${unit}`;
    },

    // The cart line the next scanned serial will name, for the hint under the
    // serial box. Null once every piece on the invoice has been named.
    get serialTargetLine() {
      if (this.serialTarget === null) return null;
      return this.cart.find((l) => l.key === this.serialTarget) || null;
    },

    // "Serial: SN-A9F2210034", or '' for the goods that carry none. Kept beside
    // warrantyText because they print together and for the same reason.
    serialText(row) {
      const code = String(row?.serial_no || '').trim();
      if (!code) return '';
      return row.returned_date ? `Serial: ${code} (returned ${this.fmtDateDMY(row.returned_date)})` : `Serial: ${code}`;
    },

    /* --------------------------------------------------------------- profit

       Two different questions, deliberately kept apart:

       Expected profit is what the stock on hand is worth if it all sells at the
       price set on entry — a projection, useful before anything is sold.

       Actual profit is what sales really earned, using the cost snapshotted
       onto each sale. It can be lower than expected because the agent is
       allowed to come down from the set price; that gap is the discount. */

    // Per-unit margin set at entry.
    itemMargin(item) {
      return Number(item?.selling_price || 0) - Number(item?.cost_price || 0);
    },

    // Profit sitting in the stock room if everything sells at the set price.
    get expectedProfit() {
      return this.inventory.reduce(
        (sum, i) => sum + this.itemMargin(i) * Number(i.quantity || 0),
        0
      );
    },

    get stockValue() {
      return this.inventory.reduce(
        (sum, i) => sum + Number(i.cost_price || 0) * Number(i.quantity || 0),
        0
      );
    },

    // What a sale actually earned. Sales with no cost snapshot (recorded before
    // this existed, or of an item never in inventory) return null rather than 0
    // — the shop does not know what they cost, and guessing zero would inflate
    // profit to the full sale price.
    saleProfit(row) {
      // The null check has to come first: Number(null) is 0, which is finite,
      // so testing only isFinite would treat "cost unknown" as "cost nothing"
      // and report the entire sale price as profit.
      if (row?.cost_price == null || row.cost_price === '') return null;
      const cost = Number(row.cost_price);
      if (!Number.isFinite(cost)) return null;
      return Number(row.total_price || 0) - cost * Number(row.quantity || 0);
    },

    // Amount given away against the set price, or 0. Same null-before-isFinite
    // reasoning as above.
    saleDiscount(row) {
      if (row?.list_price == null || row.list_price === '') return 0;
      const list = Number(row.list_price);
      if (!Number.isFinite(list)) return 0;
      const atList = list * Number(row.quantity || 0);
      const diff = atList - Number(row.total_price || 0);
      return diff > 0 ? diff : 0;
    },

    // Sum of saleProfit over a list, skipping the unknowns.
    profitOf(rows) {
      return rows.reduce((sum, r) => sum + (this.saleProfit(r) ?? 0), 0);
    },

    // True when some row in the list has no cost snapshot, so the totals above
    // are understated and the UI should say so rather than quietly mislead.
    hasUnknownCost(rows) {
      return rows.some((r) => this.saleProfit(r) === null);
    },

    /* ---------------------------------------------------------- date filter */

    setDateRange(preset) {
      const { from, to } = rangeFor(preset);
      this.dateFrom = from;
      this.dateTo = to;
      this.onDateEdit();
    },

    // Both lists fold back to five rows whenever the range changes, however it
    // changed — a preset button or the From/To boxes.
    onDateEdit() {
      this.salesLimit = ROWS_COLLAPSED;
      this.expensesLimit = ROWS_COLLAPSED;
    },

    /* Which preset button to highlight, worked out from the dates rather than
       stored alongside them. A stored value would have to be cleared in every
       path that writes a date — two @change handlers, four buttons, and the
       "show all time" escape hatch — and one missed path would leave the
       highlight claiming a range that is not on screen. Deriving it also gets
       the nice case right: type today's date into both boxes by hand and Today
       lights up, because it is today's range. '' means a custom range, where
       no button is highlighted and rangeLabel spells the dates out. */
    get activePreset() {
      if (!this.dateFrom && !this.dateTo) return 'all';
      for (const preset of ['today', 'week', 'month']) {
        const r = rangeFor(preset);
        if (r.from === this.dateFrom && r.to === this.dateTo) return preset;
      }
      return '';
    },

    get isDateFiltered() {
      return Boolean(this.dateFrom || this.dateTo);
    },

    // Both bounds inclusive. YYYY-MM-DD sorts lexicographically, so plain
    // string comparison is correct and avoids constructing dates per row.
    inDateRange(row) {
      if (this.dateFrom && (row.date || '') < this.dateFrom) return false;
      if (this.dateTo && (row.date || '') > this.dateTo) return false;
      return true;
    },

    get rangeLabel() {
      if (!this.isDateFiltered) return 'All time';
      if (this.dateFrom && this.dateTo) {
        return this.dateFrom === this.dateTo
          ? this.fmtDate(this.dateFrom)
          : `${this.fmtDate(this.dateFrom)} — ${this.fmtDate(this.dateTo)}`;
      }
      return this.dateFrom ? `From ${this.fmtDate(this.dateFrom)}` : `Up to ${this.fmtDate(this.dateTo)}`;
    },

    // -------------------------------------------------------- derived stats
    get todaysSales() {
      const t = todayLocal();
      return this.invoices.filter((inv) => inv.date === t);
    },

    get todaysRevenue() {
      return this.todaysSales.reduce((sum, inv) => sum + this.invoiceTotal(inv), 0);
    },

    /* ----------------------------------------------------------- invoices */

    invoiceTotal(inv) {
      return (inv?.lines || []).reduce((sum, l) => sum + Number(l.total_price || 0), 0);
    },

    // Profit on the lines whose cost is known; null when none of them are.
    invoiceProfit(inv) {
      const known = (inv?.lines || []).map((l) => this.saleProfit(l)).filter((p) => p !== null);
      return known.length ? known.reduce((a, b) => a + b, 0) : null;
    },

    invoiceDiscount(inv) {
      return (inv?.lines || []).reduce((sum, l) => sum + this.saleDiscount(l), 0);
    },

    /* ---------------------------------------------------- due / paid money

       An invoice with no paid_amount was issued before the shop tracked dues.
       That is not the same as "nothing has been paid", so it is read as settled
       and carries no DUE or PAID label on its receipt — the app does not know,
       and should not stamp a claim on paper that it cannot stand behind. */
    invoiceTracksPayment(inv) {
      return inv?.paid_amount !== null && inv?.paid_amount !== undefined;
    },

    invoicePaid(inv) {
      return this.invoiceTracksPayment(inv) ? Number(inv.paid_amount) : this.invoiceTotal(inv);
    },

    invoiceDue(inv) {
      return Math.max(0, this.invoiceTotal(inv) - this.invoicePaid(inv));
    },

    // Same epsilon as the server's validatePaidAmount: a total summed from
    // floats leaves a few thousandths behind, and a receipt settled to the last
    // taka must not sit in the Due list forever because of them.
    isInvoiceDue(inv) {
      return this.invoiceDue(inv) > PAID_EPSILON;
    },

    // "Router ×2" or "Router ×2 +3 more", for the history table.
    invoiceSummary(inv) {
      const lines = inv?.lines || [];
      if (!lines.length) return '—';
      const first = `${lines[0].item_name} ×${lines[0].quantity}`;
      return lines.length > 1 ? `${first} +${lines.length - 1} more` : first;
    },

    // The serials on an invoice, joined for the history row. Blank for an
    // invoice of goods that carry none, which keeps the row from growing an
    // empty second line under every cable sale.
    invoiceSerials(inv) {
      return (inv?.lines || [])
        .filter((l) => String(l.serial_no || '').trim())
        .map((l) => `${String(l.serial_no).trim()}${l.returned_date ? ' (returned)' : ''}`)
        .join(', ');
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

    /* ------------------------------------------------- collapsing sections */

    /* Flat `<name>Open` booleans rather than keys on one object: Alpine tracks a
       change to a top-level property reliably, but a change inside a nested
       object bound as `sections.products` was not picked up here — the value
       flipped and the panel stayed open.

       Every flag is written back each time. Omitting one drops it from storage
       on the next toggle, and it silently reverts to its default. */
    toggleSection(name) {
      const key = `${name}Open`;
      this[key] = !this[key];
      // The serial list is fetched on demand, not with the dashboard — see
      // GET /api/serials — so opening the section is what loads it.
      if (name === 'serials' && this.serialsOpen && !this.serialLoaded) this.loadSerials();
      this.saveSections();
    },

    saveSections() {
      writeSections({
        products: this.productsOpen,
        serials: this.serialsOpen,
        sales: this.salesOpen,
        expenses: this.expensesOpen,
        purchases: this.purchasesOpen,
      });
    },

    // Number.MAX_SAFE_INTEGER rather than the row count, so rows added after
    // expanding (a new sale, a search cleared) stay visible instead of the list
    // silently re-truncating.
    get inventoryExpanded() {
      return this.invLimit > ROWS_COLLAPSED;
    },

    toggleInventoryRows() {
      this.invLimit = this.inventoryExpanded ? ROWS_COLLAPSED : Number.MAX_SAFE_INTEGER;
    },

    get visibleInventory() {
      return this.filteredInventory.slice(0, this.invLimit);
    },

    get salesExpanded() {
      return this.salesLimit > ROWS_COLLAPSED;
    },

    toggleSalesRows() {
      this.salesLimit = this.salesExpanded ? ROWS_COLLAPSED : Number.MAX_SAFE_INTEGER;
    },

    // ------------------------------------------------------ filtered lists
    // Matches the barcode too, which makes this a second scanning surface: the
    // shopkeeper can scan into the search box to check stock and price without
    // starting a sale. Being a plain search input outside any <form>, the
    // scanner's trailing Enter does nothing here.
    get filteredInventory() {
      const q = this.invSearch.trim().toLowerCase();
      if (!q) return this.inventory;
      return this.inventory.filter(
        (i) =>
          (i.item_name || '').toLowerCase().includes(q) ||
          String(i.barcode || '').toLowerCase().includes(q)
      );
    },

    // Search matches the invoice number, customer, phone, comment, or any item
    // or serial on the invoice — "who bought the ONU modem last week?" has to
    // work, and so does a customer turning up with a dead fan and its serial.
    get filteredInvoices() {
      const q = this.saleSearch.trim().toLowerCase();
      return this.invoices.filter((inv) => {
        if (!this.inDateRange(inv)) return false;
        // The Due / Paid chips. Left out of the search box on purpose: typing
        // "due" should still find a customer's note that says so.
        if (this.saleStatus === 'due' && !this.isInvoiceDue(inv)) return false;
        if (this.saleStatus === 'paid' && this.isInvoiceDue(inv)) return false;
        if (!q) return true;
        const hay = [inv.id, inv.customer_name, inv.customer_contact, inv.comment]
          .map((v) => String(v ?? '').toLowerCase());
        return (
          hay.some((v) => v.includes(q)) ||
          inv.lines.some(
            (l) =>
              (l.item_name || '').toLowerCase().includes(q) ||
              String(l.serial_no || '').toLowerCase().includes(q)
          )
        );
      });
    },

    get visibleInvoices() {
      return this.filteredInvoices.slice(0, this.salesLimit);
    },

    get filteredLines() {
      return this.filteredInvoices.flatMap((inv) => inv.lines);
    },

    // Totals for whatever the filter currently shows — the answer to "how much
    // did I sell on this day".
    get rangeRevenue() {
      return this.filteredLines.reduce((sum, l) => sum + Number(l.total_price || 0), 0);
    },

    get rangeProfit() {
      return this.profitOf(this.filteredLines);
    },

    get rangeDiscount() {
      return this.filteredLines.reduce((sum, l) => sum + this.saleDiscount(l), 0);
    },

    // What the shop is still owed over this range. Summed over invoices, not
    // filteredLines: a due is owed on the receipt as a whole, and no line on it
    // is the one that went unpaid.
    get rangeDue() {
      return this.filteredInvoices.reduce((sum, inv) => sum + this.invoiceDue(inv), 0);
    },

    get rangeHasUnknownCost() {
      return this.hasUnknownCost(this.filteredLines);
    },

    /* ---------------------------------------------------------------- খরচ

       Expenses share the sales date range on purpose. Net profit is
       profit − expenses, and subtracting two figures measured over different
       periods would produce a number that looks precise and is simply wrong. */

    // Heads the shop has actually used, commonest first — the datalist source.
    get expenseCategories() {
      const counts = new Map();
      for (const e of this.expenses) {
        const name = String(e.category || '').trim();
        if (name) counts.set(name, (counts.get(name) || 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name]) => name);
    },

    get filteredExpenses() {
      const q = this.expenseSearch.trim().toLowerCase();
      return this.expenses.filter((e) => {
        if (!this.inDateRange(e)) return false;
        if (!q) return true;
        return (
          (e.category || '').toLowerCase().includes(q) ||
          (e.note || '').toLowerCase().includes(q)
        );
      });
    },

    get visibleExpenses() {
      return this.filteredExpenses.slice(0, this.expensesLimit);
    },

    get expensesExpanded() {
      return this.expensesLimit > ROWS_COLLAPSED;
    },

    toggleExpenseRows() {
      this.expensesLimit = this.expensesExpanded ? ROWS_COLLAPSED : Number.MAX_SAFE_INTEGER;
    },

    get rangeExpenses() {
      return this.filteredExpenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    },

    // What the shop actually made over the selected range. Inherits the
    // understatement rangeProfit carries when a sale has no cost snapshot,
    // which is why the same warning is shown beside it.
    get rangeNetProfit() {
      return this.rangeProfit - this.rangeExpenses;
    },

    // Where the money went, over the range — biggest head first.
    get expenseByCategory() {
      const totals = new Map();
      for (const e of this.filteredExpenses) {
        const name = String(e.category || '').trim() || '—';
        totals.set(name, (totals.get(name) || 0) + Number(e.amount || 0));
      }
      return [...totals.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount);
    },

    // All-time figures, for the summary card.
    get totalExpenses() {
      return this.expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    },

    get netProfit() {
      return this.profitOf(this.sales) - this.totalExpenses;
    },

    // Softly flags a head that sounds like stock buying, which belongs in Dealer
    // Purchase. A hint, never a refusal: "মাল আনার ভাড়া" is a genuine expense
    // that contains the word.
    get expenseLooksLikeStock() {
      return /(মাল|স্টক|stock|purchase|dealer|কেনা)/i.test(this.expense.category || '');
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

    get purchasesExpanded() {
      return this.purchasesLimit > ROWS_COLLAPSED;
    },

    togglePurchaseRows() {
      this.purchasesLimit = this.purchasesExpanded ? ROWS_COLLAPSED : Number.MAX_SAFE_INTEGER;
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

    async logout() {
      // Clears the httpOnly cookie server-side; the local flag alone would
      // leave a working session behind.
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      writeSession(false);
      this.isLoggedIn = false;
      this.isReceiptOpen = false;
      this.isProductOpen = false;
      this.loginEmail = '';
      this.loginPassword = '';
      this.sales = [];
      this.invoices = [];
      this.inventory = [];
      this.purchases = [];
      this.expenses = [];
      this.isExpenseOpen = false;
      this.cart = [];
      this.line = blankLine();
    },

    /* Changing the password requires being signed in and knowing the current
       one. The old public reset endpoint took an email and a new password from
       anyone who could reach the server and changed the account — it is gone. */
    async changePassword() {
      if (this.resetting) return;
      this.resetting = true;
      this.resetError = '';
      this.resetSuccess = '';
      try {
        const res = await fetch('/api/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_password: this.currentPassword,
            new_password: this.newPassword,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          this.resetSuccess = 'Password updated.';
          this.currentPassword = '';
          this.newPassword = '';
          setTimeout(() => {
            this.isPasswordOpen = false;
            this.resetSuccess = '';
          }, 1500);
        } else {
          this.resetError = data.message || 'Could not update the password.';
        }
      } catch (err) {
        this.resetError = 'Connection error. Try again.';
      } finally {
        this.resetting = false;
      }
    },

    // ---------------------------------------------------------------- data
    // `quiet` skips the loading state, for the refresh that follows a scan:
    // blanking every table on each unit scanned in would flicker the page.
    async loadData({ quiet = false } = {}) {
      if (!quiet) this.loading = true;
      this.loadError = '';
      try {
        const res = await fetch('/api/data');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load shop data.');
        this.inventory = data.inventory || [];
        this.sales = data.sales || [];
        this.invoices = buildInvoices(data.invoices || [], this.sales);
        this.purchases = data.purchases || [];
        this.expenses = data.expenses || [];
        // A sale or a return changes serial statuses too.
        if (this.serialsOpen) this.loadSerials();
      } catch (err) {
        this.loadError = err.message || 'Could not load shop data.';
        this.notify(this.loadError, 'error');
      } finally {
        this.loading = false;
      }
    },

    /* ---------------------------------------------------------------- cart */

    productByName(name) {
      const n = String(name || '').trim();
      return n ? this.inventory.find((i) => i.item_name === n) || null : null;
    },

    // When the typed or picked name is a known product, take its set price —
    // the agent can still lower it on the line.
    fillLinePrice() {
      const product = this.productByName(this.line.item_name);
      if (product) this.line.unit_price = product.selling_price;
    },

    /* Adding the same product twice raises the quantity on its existing line
       rather than printing it on the invoice twice. The existing line keeps its
       price, so a discount already agreed on it is not overwritten.

       Serial-tracked products never merge: each unit is its own qty-1 line
       carrying its own serial, because a warranty claim is about one piece and
       "qty 3, serials SN-34 / SN-35 / SN-36" cannot say which cost what once a
       discount lands on the line. Everything else — cables, bulbs — merges as
       it always has. */
    addToCart({ item_name, quantity = 1, unit_price }) {
      const name = String(item_name).trim();
      const tracked = this.serialTracked(this.productByName(name));
      const existing = !tracked && this.cart.find((l) => l.item_name === name && !l.serial_no);
      if (existing) {
        existing.quantity = (Number(existing.quantity) || 0) + Number(quantity);
        return existing;
      }
      this.cartSeq += 1;
      const entry = {
        key: this.cartSeq,
        item_name: name,
        quantity: tracked ? 1 : Number(quantity),
        unit_price,
        serial_no: '',
        tracked,
        serial_override: false,
      };
      this.cart.push(entry);
      return entry;
    },

    // The first tracked line still waiting for its serial, or null.
    nextUnnamed() {
      return this.cart.find((l) => l.tracked && !String(l.serial_no || '').trim()) || null;
    },

    get unnamedCount() {
      return this.cart.filter((l) => l.tracked && !String(l.serial_no || '').trim()).length;
    },

    // Returns false when the row is not valid, so submitSale can stop.
    addLine() {
      const name = String(this.line.item_name || '').trim();
      const qty = Number(this.line.quantity);
      const price = Number(this.line.unit_price);
      if (!name) {
        this.notify('Enter or scan an item first.', 'error');
        return false;
      }
      if (!Number.isInteger(qty) || qty < 1) {
        this.notify('Quantity must be a whole number, one or more.', 'error');
        return false;
      }
      if (this.line.unit_price === '' || !Number.isFinite(price) || price < 0) {
        this.notify('Enter a price per piece for this item.', 'error');
        return false;
      }
      /* Said out loud, not only shown on the line: the shopkeeper's eyes are on
         the item row they are typing, not on the cart below it. Still added —
         the shop may well be holding stock the count has lost track of, and
         refusing the sale would leave it with no receipt to give. */
      if (this.outOfStock(name)) {
        this.notify(`${name} is stock out. Added anyway — correct the stock count if that is wrong.`, 'error');
      }

      /* A typed "3 fans" becomes three lines, each waiting for its serial; the
         serial box takes them in order. A typed cable is one line as before. */
      const tracked = this.serialTracked(this.productByName(name));
      let first = null;
      for (let k = 0; k < (tracked ? Math.min(qty, 50) : 1); k += 1) {
        const entry = this.addToCart({ item_name: name, quantity: qty, unit_price: price });
        first = first || entry;
      }
      this.line = blankLine();
      if (tracked) {
        this.serialTarget = first.key;
        this.$nextTick(() => this.$refs.serialInput?.focus());
      } else {
        this.$nextTick(() => this.$refs.lineItem?.focus());
      }
      return true;
    },

    removeLine(key) {
      this.cart = this.cart.filter((l) => l.key !== key);
      // Otherwise the next scanned serial would land on a line that is gone.
      if (this.serialTarget === key) this.serialTarget = this.nextUnnamed()?.key ?? null;
      if (this.serialOverride?.key === key) this.serialOverride = null;
    },

    // The cart's "clear" on a serial: the line goes back to waiting, and the
    // serial box is where the right label gets scanned.
    clearSerial(l) {
      l.serial_no = '';
      l.serial_override = false;
      this.serialTarget = l.key;
      this.$nextTick(() => this.$refs.serialInput?.focus());
    },

    // Stock left for a product, or null for an item that is not in inventory.
    stockFor(name) {
      const product = this.productByName(name);
      return product ? Number(product.quantity) : null;
    },

    // Selling more than is in stock is allowed — the count may simply be wrong —
    // but it is worth a warning before the invoice is issued.
    overStock(l) {
      const stock = this.stockFor(l.item_name);
      return stock !== null && Number(l.quantity) > stock;
    },

    /* A known product with nothing left on the shelf. Worth saying louder than
       "only 2 in stock": that one is a quantity to correct, this one means the
       shop is selling something it does not have at all.

       Only for products that are in inventory — an item typed free-hand has no
       stock count to be out of, and calling it stock out would be a guess. */
    outOfStock(name) {
      const stock = this.stockFor(name);
      return stock !== null && stock <= 0;
    },

    async submitSale() {
      if (this.savingSale) return;

      // An item typed into the row but not yet added is almost certainly meant
      // to be on the invoice. Add it rather than silently leaving it off.
      if (String(this.line.item_name || '').trim() && !this.addLine()) return;

      if (this.cart.length === 0) {
        this.notify('Add at least one item to the invoice.', 'error');
        return;
      }
      // Every serial-tracked unit has to be named before the receipt exists —
      // the server refuses otherwise, and this says which line, sooner.
      const unnamed = this.nextUnnamed();
      if (unnamed) {
        this.serialTarget = unnamed.key;
        this.notify(`Scan the serial for item ${this.cart.indexOf(unnamed) + 1} (${unnamed.item_name}).`, 'error');
        beep(false);
        this.$nextTick(() => this.$refs.serialInput?.focus());
        return;
      }
      for (const [i, l] of this.cart.entries()) {
        const qty = Number(l.quantity);
        const price = Number(l.unit_price);
        if (!Number.isInteger(qty) || qty < 1 || l.unit_price === '' || !Number.isFinite(price) || price < 0) {
          this.notify(`Check item ${i + 1} (${l.item_name}): quantity and price.`, 'error');
          return;
        }
      }

      this.savingSale = true;
      try {
        const res = await fetch('/api/sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Each line's total is the stored figure; the price per piece is what
          // the shopkeeper types, so it is multiplied out here.
          // sale_time is absent deliberately — the server stamps it.
          body: JSON.stringify({
            customer_name: this.sale.customer_name,
            customer_contact: this.sale.customer_contact,
            date: this.sale.date,
            comment: this.sale.comment,
            // Blank means paid in full, so send the total rather than null —
            // null would record the invoice as untracked and print no label,
            // and a cash sale deserves its PAID receipt.
            paid_amount: this.sale.paid_amount === '' ? this.cartTotal : Number(this.sale.paid_amount),
            items: this.cart.map((l) => ({
              item_name: l.item_name,
              quantity: Number(l.quantity),
              total_price: this.lineTotal(l),
              // Blank for the goods that carry no serial, which is most of them.
              serial_no: String(l.serial_no || '').trim(),
              serial_override: Boolean(l.serial_override),
            })),
          }),
        });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not save the sale.'));
        const data = await res.json().catch(() => ({}));

        await this.loadData();
        this.sale = blankSale();
        this.cart = [];
        this.line = blankLine();
        this.scanCode = '';
        this.unknownBarcode = '';
        this.serialCode = '';
        this.serialTarget = null;
        this.serialOverride = null;
        this.notify('Sale saved — invoice ready.');

        // The button promises an invoice, so actually open one.
        const invoice = this.invoices.find((inv) => Number(inv.id) === Number(data.id));
        if (invoice) this.showReceipt(invoice);
      } catch (err) {
        this.notify(err.message || 'Could not save the sale.', 'error');
      } finally {
        this.savingSale = false;
      }
    },

    async submitDealer() {
      if (this.savingDealer) return;
      // Serial units are saved as they are scanned; there is nothing to post.
      if (this.dealerTracked) {
        this.finishDealerBatch();
        return;
      }
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
        this.dealerScanCode = '';
        this.dealerBatch = blankBatch();
        this.notify('Purchase saved — stock and prices updated.');
      } catch (err) {
        this.notify(err.message || 'Could not save the purchase.', 'error');
      } finally {
        this.savingDealer = false;
      }
    },

    // Live totals under the dealer form, so a wrong price is caught before it
    // is written onto the product.
    get dealerTotalCost() {
      const qty = Number(this.dealer.quantity);
      const cost = Number(this.dealer.cost_price);
      if (!Number.isFinite(qty) || !Number.isFinite(cost)) return 0;
      return qty * cost;
    },

    get dealerExpectedProfit() {
      const qty = Number(this.dealer.quantity);
      const cost = Number(this.dealer.cost_price);
      const sell = Number(this.dealer.selling_price);
      if (!Number.isFinite(qty) || !Number.isFinite(cost) || !Number.isFinite(sell)) return 0;
      return (sell - cost) * qty;
    },

    /* ------------------------------------------------------ barcode scanning

       A USB handheld scanner behaves as a keyboard: it types the code and
       presses Enter. Because the handler fires on Enter rather than watching
       for fast keystrokes, no debounce or timing heuristic is needed.

       The markup binds @keydown.enter.prevent.stop — .prevent is essential, not
       decorative: these inputs sit inside a <form>, and Enter's default action
       there is to submit it, which would save a half-empty record. */

    findByBarcode(code) {
      const wanted = String(code || '').trim();
      if (!wanted) return null;
      return this.inventory.find((i) => String(i.barcode || '').trim() === wanted) || null;
    },

    /* A scanner can fire twice on one label. The same code into the same box
       again within half a second is that, never a second unit — a person
       cannot pick up the next box that fast. */
    repeatScan(box, code) {
      const now = Date.now();
      const last = this.lastScan[box];
      this.lastScan[box] = { code, at: now };
      return Boolean(last && sameCode(last.code, code) && now - last.at < 500);
    },

    scanOk(message) {
      beep(true);
      this.notify(message);
    },

    scanFailed(message) {
      beep(false);
      this.notify(message, 'error');
    },

    // Sale form: fill the line from the scanned product.
    scanBarcode() {
      const code = String(this.scanCode || '').trim();
      if (!code) return;
      if (this.repeatScan('barcode', code)) {
        this.scanCode = '';
        return;
      }

      const item = this.findByBarcode(code);
      if (!item) {
        // Keep the code on screen and selected so a re-scan overwrites it, and
        // offer the product form rather than leaving a dead end.
        this.unknownBarcode = code;
        this.$refs.scanInput?.select();
        this.scanFailed(`No product with barcode ${code}.`);
        return;
      }

      this.unknownBarcode = '';
      this.scanCode = '';
      // Name taken from the inventory row verbatim, which is the point: the
      // stock decrement and the cost/warranty snapshot both match on item_name,
      // and a hand-typed name can drift from it where a scanned one cannot.
      const line = this.addToCart({ item_name: item.item_name, quantity: 1, unit_price: item.selling_price });

      /* Where focus lands is the whole ergonomics of the till. A serial-tracked
         unit's next scan is its serial, so focus moves to the serial box and
         this line becomes the one that serial names. A cable or a bulb needs
         nothing more, so focus stays put and scan-scan-scan is untouched. A
         product barcode scanned into the serial box is redirected back here
         (see scanSerial), so a wrong guess costs nothing. */
      if (line.tracked) {
        this.serialTarget = line.key;
        this.$nextTick(() => this.$refs.serialInput?.focus());
      } else {
        this.$nextTick(() => this.$refs.scanInput?.focus());
      }

      /* At a till the scanner is the whole flow — scan, scan, scan — and the
         shopkeeper is watching the scan box, not the cart. So the stock-out
         warning replaces the usual confirmation toast rather than queueing
         behind it, where it would be overwritten by the next scan. */
      if (this.outOfStock(item.item_name)) {
        this.scanFailed(
          line.tracked
            ? `${item.item_name} has no serials in stock. Scan the unit's serial, or Sell anyway.`
            : `${item.item_name} is stock out. Added anyway — correct the stock count if that is wrong.`
        );
      } else if (line.tracked) {
        this.scanOk(`${item.item_name} — now scan its serial.`);
      } else {
        this.scanOk(`${item.item_name} ×${line.quantity} — ${this.fmt(item.selling_price)}`);
      }
    },

    /* Is this product sold by the unit, one serial each? Set by the server the
       moment its first serial is scanned in, and nowhere else — goods nobody
       ever scanned a serial into sell exactly as they always did. */
    serialTracked(item) {
      return Number(item?.track_serial) === 1;
    },

    /* Sale form: the scanned serial names one unit on the invoice.

       Asked of the server, not guessed from the page: whether a unit is in
       stock, and which product it is, is only known there. The server checks
       again when the invoice is saved, so this is for the cashier's benefit —
       they hear the answer on the scan, not at the end. */
    async scanSerial() {
      const code = String(this.serialCode || '').trim();
      this.serialCode = '';
      if (!code) return;
      if (this.repeatScan('serial', code)) return;

      /* Both scan boxes are fed by the same scanner, so the next *product* is
         easily scanned while focus is still sitting here. A code that is a
         known product barcode is treated as the product scan it obviously is,
         rather than recorded as some fan's serial number. */
      if (this.findByBarcode(code)) {
        this.scanCode = code;
        this.scanBarcode();
        return;
      }

      // One serial is one piece, so the same one twice on one invoice is a
      // mis-scan — nearly always the scanner firing twice on one label.
      const clash = this.cart.find((l) => sameCode(l.serial_no, code));
      if (clash) {
        this.scanFailed(`${code} is already on this invoice (${clash.item_name}).`);
        return;
      }

      this.serialOverride = null;
      let found = null;
      try {
        const res = await fetch(`/api/serials/lookup?code=${encodeURIComponent(code)}`);
        if (res.ok) found = await res.json();
        else if (res.status !== 404) throw new Error(await this.describeFailure(res, 'Could not check the serial.'));
      } catch (err) {
        this.scanFailed(`${err.message || 'Could not check the serial.'} Scan it again.`);
        return;
      }

      // The line this serial names: the one just scanned if it still waits,
      // otherwise the first that does.
      let target = this.serialTargetLine;
      if (!target || !target.tracked || target.serial_no) target = this.nextUnnamed();

      if (found) {
        if (found.status === 'sold') {
          const who = [found.customer_name, found.sold_date && this.fmtDate(found.sold_date)].filter(Boolean).join(', ');
          this.scanFailed(`${found.serial_no} was already sold — invoice #${found.invoice_id}${who ? `, ${who}` : ''}.`);
          return;
        }
        const product = this.inventory.find((i) => Number(i.id) === Number(found.product_id));
        if (!product) {
          this.scanFailed(`${found.serial_no} belongs to a product that is no longer in stock.`);
          return;
        }
        if (target && target.item_name !== product.item_name) {
          // A second waiting line of the right product is where it belongs.
          const other = this.cart.find((l) => l.tracked && !l.serial_no && l.item_name === product.item_name);
          if (!other) {
            this.scanFailed(`${found.serial_no} is a ${product.item_name}, not ${target.item_name}. Scan the ${target.item_name}'s serial.`);
            return;
          }
          target = other;
        }
        // Nothing waiting: the serial alone says which product, so the
        // barcode scan can be skipped altogether.
        if (!target) target = this.addToCart({ item_name: product.item_name, quantity: 1, unit_price: product.selling_price });
        target.serial_no = found.serial_no;
        target.serial_override = false;
        this.serialNamed(target);
        return;
      }

      if (!target) {
        this.scanFailed(`${code} is not registered. Scan the product first, then its serial.`);
        return;
      }
      // Probably a unit from before the shop began scanning serials in. Held
      // for the cashier to confirm rather than refused outright.
      this.serialOverride = { code, key: target.key };
      this.scanFailed(`${code} is not in stock for ${target.item_name}. Check the label, or Sell anyway.`);
    },

    // A serial has been attached to `line`: move on to the next unit waiting,
    // or back to the barcode box for the next product.
    serialNamed(line) {
      this.serialOverride = null;
      const next = this.nextUnnamed();
      this.serialTarget = next ? next.key : null;
      this.scanOk(`${line.item_name} — ${line.serial_no}${next ? `. Next: serial for ${next.item_name}.` : ''}`);
      this.$nextTick(() => (next ? this.$refs.serialInput : this.$refs.scanInput)?.focus());
    },

    // "Sell anyway": the server registers the unit and sells it in one step.
    sellAnyway() {
      const pending = this.serialOverride;
      const line = pending && this.cart.find((l) => l.key === pending.key);
      if (!line) {
        this.serialOverride = null;
        return;
      }
      line.serial_no = pending.code;
      line.serial_override = true;
      this.serialNamed(line);
    },

    cancelOverride() {
      this.serialOverride = null;
      this.$nextTick(() => this.$refs.serialInput?.focus());
    },

    /* ------------------------------------------------ dealer form: receiving

       Goods without serials use the Quantity field and "Save Dealer Batch" as
       before. Goods with serials are received one scan per unit: scan the
       product's barcode once, then its serials one after another, each saved
       the moment it is scanned. */

    get dealerProduct() {
      return this.productByName(this.dealer.item_name);
    },

    // Serial mode: the product is already tracked, or this batch has begun
    // scanning serials into it — scanning into the serial box is the switch.
    get dealerTracked() {
      return this.serialTracked(this.dealerProduct) || this.dealerBatch.units.length > 0;
    },

    // Dealer form: a known code fills the product being restocked; an unknown
    // one is simply kept, since this form is also how new products are created.
    scanDealerBarcode() {
      const code = String(this.dealerScanCode || '').trim();
      this.dealerScanCode = '';
      if (!code) return;
      if (this.repeatScan('dealer-barcode', code)) return;
      this.dealer.barcode = code;

      const item = this.findByBarcode(code);
      if (item) {
        this.dealer.item_name = item.item_name;
        this.dealer.cost_price = item.cost_price;
        this.dealer.selling_price = item.selling_price;
        this.dealer.warranty_months = item.warranty_months ?? 0;
        if (this.dealerBatch.item_name !== item.item_name) this.dealerBatch = blankBatch();
        if (this.serialTracked(item)) {
          this.scanOk(`${item.item_name} (${item.quantity} in stock) — scan each unit's serial.`);
          this.$nextTick(() => this.$refs.dealerSerial?.focus());
        } else {
          this.scanOk(`Restocking ${item.item_name}.`);
          this.$nextTick(() => this.$refs.dealerQty?.focus());
        }
      } else {
        this.dealerBatch = blankBatch();
        this.scanOk(`New barcode ${code} — fill in the product details.`);
        this.$nextTick(() => this.$refs.dealerItem?.focus());
      }
    },

    scanDealerSerial() {
      const code = String(this.dealerSerialCode || '').trim();
      this.dealerSerialCode = '';
      if (!code) return;
      if (this.repeatScan('dealer-serial', code)) return;

      // The next product's barcode, scanned while focus sat here: switch to
      // that product, which is exactly what the shopkeeper meant.
      if (this.findByBarcode(code)) {
        this.dealerScanCode = code;
        this.scanDealerBarcode();
        return;
      }
      queueScan(() => this.receiveDealerSerial(code));
    },

    async receiveDealerSerial(code) {
      const d = this.dealer;
      const name = String(d.item_name || '').trim();
      const missing = !String(d.dealer_name || '').trim()
        ? ['Enter the dealer name first.', 'dealerName']
        : !name
          ? ['Scan the product barcode first.', 'dealerScan']
          : d.cost_price === '' || d.cost_price == null
            ? ['Enter the buying price first.', 'dealerBuy']
            : null;
      if (missing) {
        this.scanFailed(missing[0]);
        this.$nextTick(() => this.$refs[missing[1]]?.focus());
        return;
      }

      if (this.dealerBatch.item_name !== name) this.dealerBatch = { ...blankBatch(), item_name: name };
      if (this.dealerBatch.units.some((u) => sameCode(u.serial_no, code))) {
        this.scanFailed(`${code} is already scanned in this batch.`);
        return;
      }

      try {
        const res = await fetch('/api/serials/receive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dealer_name: d.dealer_name,
            item_name: name,
            barcode: d.barcode,
            cost_price: d.cost_price,
            selling_price: d.selling_price,
            warranty_months: d.warranty_months,
            date: d.date,
            serial_no: code,
            purchase_id: this.dealerBatch.purchase_id,
          }),
        });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not register the serial.'));
        const out = await res.json();
        this.dealerBatch.purchase_id = out.purchase_id;
        this.dealerBatch.units.unshift({ id: out.serial.id, serial_no: out.serial.serial_no });
        this.putProduct(out.product);
        this.scanOk(`${name} | Qty: ${this.dealerBatch.units.length} | ${out.serial.serial_no}`);
        this.refreshSoon();
      } catch (err) {
        this.scanFailed(err.message || 'Could not register the serial.');
      }
    },

    // ✕ on a unit just scanned in: a mis-scan, taken back out of stock.
    async removeDealerUnit(unit) {
      const out = await this.deleteSerial(unit.id);
      if (!out) return;
      this.dealerBatch.units = this.dealerBatch.units.filter((u) => u.id !== unit.id);
      // The server drops a batch left empty, so the next scan starts afresh.
      if (!this.dealerBatch.units.length) this.dealerBatch.purchase_id = null;
      this.notify(`${unit.serial_no} removed.`);
    },

    // The batch is already saved scan by scan; this only clears the form for
    // the next product, keeping the dealer and date that usually carry over.
    finishDealerBatch() {
      const n = this.dealerBatch.units.length;
      const name = this.dealerBatch.item_name || this.dealer.item_name;
      this.dealer = { ...blankDealer(), dealer_name: this.dealer.dealer_name, date: this.dealer.date };
      this.dealerBatch = blankBatch();
      this.loadData({ quiet: true });
      this.notify(n ? `Saved — ${n} unit(s) of ${name} received.` : 'Ready for the next product.');
      this.$nextTick(() => this.$refs.dealerScan?.focus());
    },

    // Shared by every ✕ on a serial. Returns the server's reply, or null
    // after saying why it failed.
    async deleteSerial(id) {
      try {
        const res = await fetch(`/api/serials/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not remove the serial.'));
        const out = await res.json();
        if (out.product) this.putProduct(out.product);
        this.refreshSoon();
        return out;
      } catch (err) {
        this.notify(err.message || 'Could not remove the serial.', 'error');
        return null;
      }
    },

    // A product row the server just returned, put straight into the list so
    // the stock count moves with the scan instead of after the next reload.
    putProduct(product) {
      if (!product) return;
      const i = this.inventory.findIndex((p) => Number(p.id) === Number(product.id));
      if (i === -1) this.inventory.push(product);
      else this.inventory.splice(i, 1, product);
    },

    // One quiet reload after a run of scans settles, for the purchase history
    // and totals — not one per scan.
    refreshSoon() {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.loadData({ quiet: true }), 1500);
    },

    /* --------------------------------------------------------- খরচ entry */

    async submitExpense() {
      if (this.savingExpense) return;
      this.savingExpense = true;
      try {
        const res = await fetch('/api/expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.expense),
        });
        // describeFailure, not data.error: it is the one that explains an older
        // server answering with an HTML 404 instead of JSON.
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not save the expense.'));

        await this.loadData();
        this.expense = blankExpense();
        this.notify('Expense saved.');
      } catch (err) {
        this.notify(err.message || 'Could not save the expense.', 'error');
      } finally {
        this.savingExpense = false;
      }
    },

    // Spread, never the live row: binding x-model straight to the expenses entry
    // would edit the table behind the dialog as you type, and keep the change on
    // Cancel. Same reasoning as openEditProduct().
    openEditExpense(row) {
      this.expenseDraft = { ...blankExpense(), ...row };
      this.expenseError = '';
      this.confirmExpenseDelete = false;
      this.isExpenseOpen = true;
    },

    closeExpense() {
      this.isExpenseOpen = false;
      this.confirmExpenseDelete = false;
    },

    async submitExpenseEdit() {
      if (this.savingExpenseEdit) return;
      this.savingExpenseEdit = true;
      this.expenseError = '';
      try {
        const res = await fetch(`/api/expenses/${this.expenseDraft.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.expenseDraft),
        });
        // Left open on failure so the reason is readable where it was typed.
        if (!res.ok) {
          this.expenseError = await this.describeFailure(res, 'Could not save the expense.');
          return;
        }
        await this.loadData();
        this.closeExpense();
        this.notify('Expense updated.');
      } catch (err) {
        this.expenseError = 'Connection error. Try again.';
      } finally {
        this.savingExpenseEdit = false;
      }
    },

    async deleteExpense() {
      if (this.savingExpenseEdit) return;
      this.savingExpenseEdit = true;
      try {
        const res = await fetch(`/api/expenses/${this.expenseDraft.id}`, { method: 'DELETE' });
        if (!res.ok) {
          this.expenseError = await this.describeFailure(res, 'Could not delete the expense.');
          return;
        }
        await this.loadData();
        this.closeExpense();
        this.notify('Expense deleted.');
      } catch (err) {
        this.expenseError = 'Connection error. Try again.';
      } finally {
        this.savingExpenseEdit = false;
      }
    },

    /* ------------------------------------------ payment on an issued invoice */

    /* A copy, never the live invoice: binding the row itself would rewrite the
       history table as the shopkeeper types, and cancelling would leave the
       typed figure sitting in a list it was never saved to. The total is
       snapshotted alongside so the dialog can show the due without re-walking the
       lines on every keystroke. */
    openPayment(inv) {
      this.paymentDraft = {
        id: inv.id,
        customer_name: inv.customer_name,
        total: this.invoiceTotal(inv),
        paid_amount: this.invoiceTracksPayment(inv) ? Number(inv.paid_amount) : this.invoiceTotal(inv),
      };
      this.paymentError = '';
      this.isPaymentOpen = true;
    },

    closePayment() {
      this.isPaymentOpen = false;
      this.paymentError = '';
    },

    // The one-click settle: the customer came back and cleared the balance.
    markFullyPaid() {
      this.paymentDraft.paid_amount = this.paymentDraft.total;
    },

    get paymentDue() {
      const paid = Number(this.paymentDraft.paid_amount);
      if (!Number.isFinite(paid)) return this.paymentDraft.total;
      return Math.max(0, this.paymentDraft.total - paid);
    },

    async submitPayment() {
      if (this.savingPayment) return;
      this.savingPayment = true;
      this.paymentError = '';
      try {
        const res = await fetch(`/api/invoices/${this.paymentDraft.id}/payment`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paid_amount: this.paymentDraft.paid_amount }),
        });
        // Left open on failure so the reason is readable where it was typed.
        if (!res.ok) {
          this.paymentError = await this.describeFailure(res, 'Could not save the payment.');
          return;
        }
        const id = this.paymentDraft.id;
        await this.loadData();

        /* The receipt modal may be open behind this dialog, showing the very
           invoice just settled. currentReceipt holds the old object from before
           loadData() replaced the array, so without this the corner label would
           still read DUE until the receipt was closed and reopened. */
        if (Number(this.currentReceipt?.id) === Number(id)) {
          const fresh = this.invoices.find((inv) => Number(inv.id) === Number(id));
          if (fresh) this.currentReceipt = fresh;
        }

        this.closePayment();
        this.notify('Payment updated.');
      } catch (err) {
        this.paymentError = 'Connection error. Try again.';
      } finally {
        this.savingPayment = false;
      }
    },

    /* ------------------------------------------------------- product manager */

    openAddProduct(prefill = {}) {
      this.product = { ...blankProduct(), ...prefill };
      this.productMode = 'add';
      this.productError = '';
      this.confirmDelete = false;
      this.isProductOpen = true;
      this.productSerials = [];
      this.productSerialCode = '';
    },

    // Stock on this form is the serial count: an existing tracked product, or
    // a new one with serials scanned in before it is added.
    get productSerialMode() {
      return this.serialTracked(this.product) || (this.productMode === 'add' && this.productSerials.length > 0);
    },

    // Spread, never the live row: binding x-model straight to an inventory
    // object would edit the table behind the modal as you type, and leave the
    // changes there even if you cancel.
    openEditProduct(item) {
      this.product = { ...blankProduct(), ...item };
      this.productMode = 'edit';
      this.productError = '';
      this.confirmDelete = false;
      this.isProductOpen = true;
      this.productSerials = [];
      this.productSerialCode = '';
      this.loadProductSerials();
    },

    /* ----------------------------------------- product screen: serials in stock

       How stock the shop already had becomes serial-tracked: open the product,
       scan every unit on the shelf. Each scan is saved at once, with no dealer
       purchase — these units were bought long ago. From the first scan on, the
       product's stock is the number of serials scanned here. */

    async loadProductSerials() {
      const id = this.product.id;
      if (!id) return;
      this.productSerialsLoading = true;
      try {
        const res = await fetch(`/api/serials?product_id=${id}&status=available&limit=1000`);
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not load the serials.'));
        const data = await res.json();
        // The modal may have moved on to another product while this loaded.
        if (this.product.id === id) this.productSerials = data.rows || [];
      } catch (err) {
        this.productError = err.message || 'Could not load the serials.';
      } finally {
        this.productSerialsLoading = false;
      }
    },

    scanProductSerial() {
      const code = String(this.productSerialCode || '').trim();
      this.productSerialCode = '';
      if (!code) return;
      if (this.repeatScan('product-serial', code)) return;
      if (this.findByBarcode(code)) {
        this.scanFailed(`${code} is a product barcode, not a serial number.`);
        return;
      }
      if (this.productSerials.some((u) => sameCode(u.serial_no, code))) {
        this.scanFailed(`${code} is already scanned for this product.`);
        return;
      }
      if (sameCode(code, this.product.barcode)) {
        this.scanFailed(`${code} is this product's barcode, not a serial number.`);
        return;
      }
      if (this.productMode === 'add') {
        queueScan(() => this.holdNewProductSerial(code));
        return;
      }
      const id = this.product.id;
      queueScan(async () => {
        try {
          const res = await fetch('/api/serials/receive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_id: id, serial_no: code }),
          });
          if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not register the serial.'));
          const out = await res.json();
          this.putProduct(out.product);
          if (this.product.id === id) {
            this.productSerials.unshift(out.serial);
            this.product.quantity = out.product.quantity;
            this.product.track_serial = out.product.track_serial;
          }
          this.scanOk(`${out.product.item_name} | Stock: ${out.product.quantity} | ${out.serial.serial_no}`);
        } catch (err) {
          this.scanFailed(err.message || 'Could not register the serial.');
        }
      });
    },

    /* Add Product: the product does not exist yet, so a scanned serial is held
       here and sent with it — POST /api/inventory registers them together.
       Asked of the server now all the same, so a serial already taken is
       refused on the scan rather than when Add Product is pressed. */
    async holdNewProductSerial(code) {
      try {
        const res = await fetch(`/api/serials/lookup?code=${encodeURIComponent(code)}`);
        if (res.ok) {
          const found = await res.json();
          this.scanFailed(
            found.status === 'sold'
              ? `${found.serial_no} was already sold — invoice #${found.invoice_id}.`
              : `${found.serial_no} is already in stock for ${found.item_name || 'another product'}.`
          );
          return;
        }
        if (res.status !== 404) throw new Error(await this.describeFailure(res, 'Could not check the serial.'));
      } catch (err) {
        this.scanFailed(`${err.message || 'Could not check the serial.'} Scan it again.`);
        return;
      }
      if (this.productMode !== 'add' || this.productSerials.some((u) => sameCode(u.serial_no, code))) return;
      this.productSerials.unshift({ id: `new-${Date.now()}-${code}`, serial_no: code, received_date: todayLocal(), pending: true });
      this.product.quantity = this.productSerials.length;
      this.scanOk(`${this.product.item_name || 'New product'} | Qty: ${this.productSerials.length} | ${code}`);
    },

    async removeProductSerial(unit) {
      if (unit.pending) {
        this.productSerials = this.productSerials.filter((u) => u.id !== unit.id);
        this.product.quantity = this.productSerials.length;
        return;
      }
      const out = await this.deleteSerial(unit.id);
      if (!out) return;
      this.productSerials = this.productSerials.filter((u) => u.id !== unit.id);
      if (out.product && this.product.id === out.product.id) {
        this.product.quantity = out.product.quantity;
        this.product.track_serial = out.product.track_serial;
      }
      this.notify(`${unit.serial_no} removed from stock.`);
    },

    closeProduct() {
      this.isProductOpen = false;
      this.confirmDelete = false;
    },

    // How many records would be left referring to this product by name.
    // Counted locally from data already loaded — no endpoint needed.
    productUsage(name) {
      const n = String(name || '');
      return {
        sales: this.sales.filter((s) => s.item_name === n).length,
        purchases: this.purchases.filter((p) => p.item_name === n).length,
      };
    },

    /* The prices on this form are per piece; these three show what that comes
       to across the quantity entered, so "300" can never be mistaken for the
       total paid for the whole batch. */
    get productMargin() {
      const cost = Number(this.product.cost_price);
      const sell = Number(this.product.selling_price);
      if (!Number.isFinite(cost) || !Number.isFinite(sell)) return 0;
      return sell - cost;
    },

    get productQty() {
      const q = Number(this.product.quantity);
      return Number.isFinite(q) ? q : 0;
    },

    get productTotalCost() {
      const cost = Number(this.product.cost_price);
      return Number.isFinite(cost) ? cost * this.productQty : 0;
    },

    get productTotalSale() {
      const sell = Number(this.product.selling_price);
      return Number.isFinite(sell) ? sell * this.productQty : 0;
    },

    get productTotalProfit() {
      return this.productMargin * this.productQty;
    },

    async submitProduct() {
      if (this.savingProduct) return;
      this.savingProduct = true;
      this.productError = '';
      try {
        const editing = this.productMode === 'edit';
        const res = await fetch(
          editing ? `/api/inventory/${this.product.id}` : '/api/inventory',
          {
            method: editing ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              item_name: this.product.item_name,
              barcode: this.product.barcode,
              quantity: this.product.quantity,
              cost_price: this.product.cost_price,
              selling_price: this.product.selling_price,
              warranty_months: this.product.warranty_months,
              // Serials scanned before the product existed, registered with it.
              ...(editing ? {} : { serials: this.productSerials.map((u) => u.serial_no) }),
            }),
          }
        );
        // Left open on failure on purpose: a duplicate barcode has to be
        // readable and fixable where it was typed.
        if (!res.ok) {
          this.productError = await this.describeFailure(res, 'Could not save the product.');
          return;
        }
        const data = await res.json().catch(() => ({}));

        await this.loadData();
        this.closeProduct();
        this.notify(
          data.renamed
            ? `Product updated — ${data.renamed} history record(s) renamed too.`
            : editing
              ? 'Product updated.'
              : 'Product added.'
        );
      } catch (err) {
        this.productError = 'Connection error. Try again.';
      } finally {
        this.savingProduct = false;
      }
    },

    async deleteProduct() {
      if (this.savingProduct) return;
      this.savingProduct = true;
      try {
        const res = await fetch(`/api/inventory/${this.product.id}`, { method: 'DELETE' });
        if (!res.ok) {
          this.productError = await this.describeFailure(res, 'Could not delete the product.');
          return;
        }
        await this.loadData();
        this.closeProduct();
        this.notify('Product deleted. Past sales and invoices are unchanged.');
      } catch (err) {
        this.productError = 'Connection error. Try again.';
      } finally {
        this.savingProduct = false;
      }
    },

    /* ------------------------------------------------- Serial / IMEI section */

    async loadSerials(more = false) {
      this.serialLoading = true;
      try {
        const params = new URLSearchParams({ limit: '50', offset: String(more ? this.serialRows.length : 0) });
        if (this.serialQuery.trim()) params.set('q', this.serialQuery.trim());
        if (this.serialStatus !== 'all') params.set('status', this.serialStatus);
        if (this.serialProductId) params.set('product_id', this.serialProductId);
        const res = await fetch(`/api/serials?${params}`);
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not load the serials.'));
        const data = await res.json();
        this.serialRows = more ? [...this.serialRows, ...(data.rows || [])] : data.rows || [];
        this.serialTotal = data.total || 0;
        this.serialLoaded = true;
      } catch (err) {
        this.notify(err.message || 'Could not load the serials.', 'error');
      } finally {
        this.serialLoading = false;
      }
    },

    // "Serials" on a product row: this section, filtered to that product.
    openSerialsFor(item) {
      this.serialsOpen = true;
      this.saveSections();
      this.serialProductId = String(item.id);
      this.serialQuery = '';
      this.serialStatus = 'all';
      this.loadSerials();
      this.$nextTick(() => document.getElementById('serials-section')?.scrollIntoView({ behavior: 'smooth' }));
    },

    // The invoice a sold serial went out on, opened as its receipt.
    openSerialInvoice(row) {
      const inv = this.invoices.find((i) => Number(i.id) === Number(row.invoice_id));
      if (inv) this.showReceipt(inv);
      else this.notify(`Invoice #${row.invoice_id} is not loaded.`, 'error');
    },

    async openSerialHistory(row) {
      this.serialDialog = { mode: 'history', row, events: [], note: '', error: '', saving: false, loading: true };
      try {
        const res = await fetch(`/api/serials/${row.id}/history`);
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not load the history.'));
        const data = await res.json();
        if (this.serialDialog?.row === row) this.serialDialog.events = data.events || [];
      } catch (err) {
        if (this.serialDialog) this.serialDialog.error = err.message || 'Could not load the history.';
      } finally {
        if (this.serialDialog) this.serialDialog.loading = false;
      }
    },

    openSerialAction(row, mode) {
      this.serialDialog = { mode, row, events: [], note: '', error: '', saving: false, loading: false };
    },

    closeSerialDialog() {
      this.serialDialog = null;
    },

    serialEventText(e) {
      if (e.event === 'received') {
        return e.dealer_name ? `Received from ${e.dealer_name}` : e.note || 'Added to stock';
      }
      if (e.event === 'sold') return `Sold — invoice #${e.invoice_id}${e.customer_name ? `, ${e.customer_name}` : ''}`;
      if (e.event === 'returned') {
        return `Returned from invoice #${e.invoice_id}${e.customer_name ? `, ${e.customer_name}` : ''}${e.note ? ` — ${e.note}` : ''}`;
      }
      return e.event;
    },

    // Return (a sold unit back into stock) or Remove (a mis-scan taken out).
    async confirmSerialAction() {
      const dlg = this.serialDialog;
      if (!dlg || dlg.saving) return;
      dlg.saving = true;
      dlg.error = '';
      try {
        if (dlg.mode === 'return') {
          const res = await fetch(`/api/serials/${dlg.row.id}/return`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: dlg.note }),
          });
          if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not record the return.'));
          this.notify(`${dlg.row.serial_no} is back in stock. Record any cash refund yourself.`);
        } else {
          const res = await fetch(`/api/serials/${dlg.row.id}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not remove the serial.'));
          this.notify(`${dlg.row.serial_no} removed from stock.`);
        }
        this.serialDialog = null;
        await this.loadData({ quiet: true });
      } catch (err) {
        dlg.error = err.message || 'Something went wrong.';
      } finally {
        dlg.saving = false;
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

      // The masthead logo is an image. If the print dialog opens before it has
      // decoded — first visit, slow connection to the hosted site — the invoice
      // prints with a blank box where the logo should be, and the shop only
      // finds out from the customer's copy. Wait for it, but never hang the
      // print button on a logo that fails to load.
      const images = [...document.querySelectorAll('#receipt-paper img')];
      await Promise.race([
        // decode() resolves once the image is loaded and ready to paint, and
        // rejects if it fails — which is swallowed so a broken logo still prints.
        Promise.all(images.map((img) => img.decode().catch(() => {}))),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);

      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
      document.title = this.receiptFilename();
      window.print();
    },
  };
}

window.shopApp = shopApp;
