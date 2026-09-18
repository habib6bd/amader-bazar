/* NetBazar — dashboard logic (Alpine.js component).
   Loaded after shop-config.js and before alpine.min.js, so both SHOP and
   shopApp() exist when Alpine boots. */

// Stock at or below this count is flagged as low.
const LOW_STOCK_THRESHOLD = 5;

// How many sales/purchases rows to show before "Load more".
const PAGE_SIZE = 25;

// Rows a long table shows before it is expanded. Small on purpose: the till is
// used on a laptop at a counter, and a shop with a hundred products should not
// have to scroll past all of them to reach the next section.
const ROWS_COLLAPSED = 5;

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
const DEFAULT_SECTIONS = { products: true, sales: true };

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
function blankSale() {
  return {
    customer_name: '',
    customer_contact: '',
    date: todayLocal(),
    comment: '',
  };
}

// The "add an item" row above the cart. Price is per piece, matching the
// invoice's "Price/ Unit" column; the line amount is derived, never typed.
function blankLine() {
  return { item_name: '', quantity: 1, unit_price: '' };
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
    // Both start collapsed to five rows; "Show all" opens them fully.
    invLimit: ROWS_COLLAPSED,
    salesLimit: ROWS_COLLAPSED,
    purchasesLimit: PAGE_SIZE,
    /* Two flat booleans rather than one `sections` object: Alpine tracks a
       change to a top-level property reliably, but a change to a key *inside* a
       nested object bound as `sections.products` was not picked up here — the
       value changed and the panel stayed open. Flat is also less to read. */
    productsOpen: readSections().products,
    salesOpen: readSections().sales,

    sale: blankSale(),
    // The invoice being built: [{ key, item_name, quantity, unit_price }].
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

    toast: { show: false, message: '', type: 'success' },
    toastTimer: null,

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

    // "Router ×2" or "Router ×2 +3 more", for the history table.
    invoiceSummary(inv) {
      const lines = inv?.lines || [];
      if (!lines.length) return '—';
      const first = `${lines[0].item_name} ×${lines[0].quantity}`;
      return lines.length > 1 ? `${first} +${lines.length - 1} more` : first;
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

    toggleSection(name) {
      if (name === 'products') this.productsOpen = !this.productsOpen;
      else this.salesOpen = !this.salesOpen;
      writeSections({ products: this.productsOpen, sales: this.salesOpen });
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
    // on the invoice — "who bought the ONU modem last week?" has to work.
    get filteredInvoices() {
      const q = this.saleSearch.trim().toLowerCase();
      return this.invoices.filter((inv) => {
        if (!this.inDateRange(inv)) return false;
        if (!q) return true;
        const hay = [inv.id, inv.customer_name, inv.customer_contact, inv.comment]
          .map((v) => String(v ?? '').toLowerCase());
        return (
          hay.some((v) => v.includes(q)) ||
          inv.lines.some((l) => (l.item_name || '').toLowerCase().includes(q))
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

    get rangeHasUnknownCost() {
      return this.hasUnknownCost(this.filteredLines);
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
    async loadData() {
      this.loading = true;
      this.loadError = '';
      try {
        const res = await fetch('/api/data');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load shop data.');
        this.inventory = data.inventory || [];
        this.sales = data.sales || [];
        this.invoices = buildInvoices(data.invoices || [], this.sales);
        this.purchases = data.purchases || [];
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

    // Adding the same product twice raises the quantity on its existing line
    // rather than printing it on the invoice twice. The existing line keeps its
    // price, so a discount already agreed on it is not overwritten.
    addToCart({ item_name, quantity = 1, unit_price }) {
      const name = String(item_name).trim();
      const existing = this.cart.find((l) => l.item_name === name);
      if (existing) {
        existing.quantity = (Number(existing.quantity) || 0) + Number(quantity);
        return existing;
      }
      this.cartSeq += 1;
      const entry = { key: this.cartSeq, item_name: name, quantity: Number(quantity), unit_price };
      this.cart.push(entry);
      return entry;
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
      this.addToCart({ item_name: name, quantity: qty, unit_price: price });
      this.line = blankLine();
      this.$nextTick(() => this.$refs.lineItem?.focus());
      return true;
    },

    removeLine(key) {
      this.cart = this.cart.filter((l) => l.key !== key);
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

    async submitSale() {
      if (this.savingSale) return;

      // An item typed into the row but not yet added is almost certainly meant
      // to be on the invoice. Add it rather than silently leaving it off.
      if (String(this.line.item_name || '').trim() && !this.addLine()) return;

      if (this.cart.length === 0) {
        this.notify('Add at least one item to the invoice.', 'error');
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
            items: this.cart.map((l) => ({
              item_name: l.item_name,
              quantity: Number(l.quantity),
              total_price: this.lineTotal(l),
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

    // Sale form: fill the line from the scanned product.
    scanBarcode() {
      const code = String(this.scanCode || '').trim();
      if (!code) return;

      const item = this.findByBarcode(code);
      if (!item) {
        // Keep the code on screen and selected so a re-scan overwrites it, and
        // offer the product form rather than leaving a dead end.
        this.unknownBarcode = code;
        this.$refs.scanInput?.select();
        this.notify(`No product with barcode ${code}.`, 'error');
        return;
      }

      this.unknownBarcode = '';
      this.scanCode = '';
      // Name taken from the inventory row verbatim, which is the point: the
      // stock decrement and the cost/warranty snapshot both match on item_name,
      // and a hand-typed name can drift from it where a scanned one cannot.
      const line = this.addToCart({ item_name: item.item_name, quantity: 1, unit_price: item.selling_price });
      this.notify(`${item.item_name} ×${line.quantity} — ${this.fmt(item.selling_price)}`);

      // Focus stays in the scan box: at a till the next action is scanning the
      // next item, not typing.
      this.$nextTick(() => this.$refs.scanInput?.focus());
    },

    // Dealer form: a known code fills the product being restocked; an unknown
    // one is simply kept, since this form is also how new products are created.
    scanDealerBarcode() {
      const code = String(this.dealerScanCode || '').trim();
      if (!code) return;
      this.dealer.barcode = code;

      const item = this.findByBarcode(code);
      if (item) {
        this.dealer.item_name = item.item_name;
        this.dealer.cost_price = item.cost_price;
        this.dealer.selling_price = item.selling_price;
        this.dealer.warranty_months = item.warranty_months ?? 0;
        this.notify(`Restocking ${item.item_name}.`);
        this.$nextTick(() => this.$refs.dealerQty?.focus());
      } else {
        this.notify(`New barcode ${code} — fill in the product details.`);
        this.$nextTick(() => this.$refs.dealerItem?.focus());
      }
      this.dealerScanCode = '';
    },

    /* ------------------------------------------------------- product manager */

    openAddProduct(prefill = {}) {
      this.product = { ...blankProduct(), ...prefill };
      this.productMode = 'add';
      this.productError = '';
      this.confirmDelete = false;
      this.isProductOpen = true;
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
