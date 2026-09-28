/* NetBazar — dashboard logic (Alpine.js component).
   Loaded after shop-config.js and before alpine.min.js, so both SHOP and
   shopApp() exist when Alpine boots. */

// Stock at or below this count is flagged as low.
const LOW_STOCK_THRESHOLD = 5;

// Rows a long table shows before it is expanded. Each list has a page of its
// own, so this is a screenful rather than a teaser — but still a limit, so a
// shop with a thousand invoices does not render every row to open the page.
const ROWS_COLLAPSED = 25;

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

  // Rolling windows, today included, whatever the day of the week or month:
  // This Week is the last 7 days and This Month the last 30.
  const lastDays = (n) => {
    const start = new Date(d);
    start.setDate(d.getDate() - (n - 1));
    return { from: iso(start), to: iso(d) };
  };

  if (preset === 'week') return lastDays(7);
  if (preset === 'month') return lastDays(30);

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

/* Whether the desktop sidebar is folded down to its icons, remembered per
   browser. Purely cosmetic: losing it costs nothing, which is why every access
   is wrapped rather than guarded. */
const SIDEBAR_KEY = 'shop-sidebar';

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed) {
  try {
    if (collapsed) localStorage.setItem(SIDEBAR_KEY, 'collapsed');
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* nothing to do — the sidebar simply opens full width next visit */
  }
}

/* ---------------------------------------------------------------- pages

   Every screen of the app, keyed by the name the markup tests (`page === …`),
   with the address it lives at. Hash routing rather than paths: the server
   serves one index.html and needs no route of its own per page, and a hash
   survives a refresh, so a shopkeeper reloading the till stays on the till.

   Each page is an x-show panel, never x-if — the cart, a half-filled dealer
   form and the scanner's refs must all survive a trip to another page. */
const PAGES = {
  dashboard: { hash: '', title: 'Dashboard' },
  sale: { hash: 'sales/new', title: 'New Sale', group: 'sales' },
  sales: { hash: 'sales', title: 'Sales History', group: 'sales' },
  purchase: { hash: 'purchases/new', title: 'New Purchase', group: 'purchases' },
  purchases: { hash: 'purchases', title: 'Purchase History', group: 'purchases' },
  products: { hash: 'products', title: 'Products', group: 'stock' },
  lowstock: { hash: 'products/low-stock', title: 'Low Stock', group: 'stock' },
  customers: { hash: 'customers', title: 'Customers' },
  suppliers: { hash: 'suppliers', title: 'Suppliers' },
  expenses: { hash: 'expenses', title: 'Expenses' },
  serials: { hash: 'serials', title: 'Serial / IMEI' },
  warranty: { hash: 'warranty', title: 'Warranty Claims' },
  faulty: { hash: 'faulty', title: 'Faulty & Supplier' },
  rsales: { hash: 'reports/sales', title: 'Sales Report', group: 'reports' },
  rpnl: { hash: 'reports/profit-loss', title: 'Profit & Loss', group: 'reports' },
  rstock: { hash: 'reports/stock', title: 'Stock Report', group: 'reports' },
  rexpenses: { hash: 'reports/expenses', title: 'Expense Report', group: 'reports' },
};

// hash → page name, for reading the address bar.
const PAGE_BY_HASH = Object.fromEntries(Object.entries(PAGES).map(([name, p]) => [p.hash, name]));

// The page an address points at; anything unknown is the dashboard.
function pageFromHash(hash) {
  const key = String(hash || '').replace(/^#\/?/, '').replace(/\/+$/, '');
  return PAGE_BY_HASH[key] ?? 'dashboard';
}

/* The sidebar, built from the pages above. Only what the app really does is
   listed — no menu item leads to a placeholder. */
const NAV = [
  { page: 'dashboard', label: 'Dashboard', icon: 'home' },
  { group: 'sales', label: 'Sales', icon: 'cart', children: ['sale', 'sales'] },
  { group: 'purchases', label: 'Purchases', icon: 'truck', children: ['purchase', 'purchases'] },
  { group: 'stock', label: 'Products & Stock', icon: 'cube', children: ['products', 'lowstock'] },
  { page: 'customers', label: 'Customers', icon: 'users' },
  { page: 'suppliers', label: 'Suppliers', icon: 'store' },
  { page: 'expenses', label: 'Expenses', icon: 'banknotes' },
  { page: 'serials', label: 'Serial / IMEI', icon: 'hashtag' },
  { page: 'warranty', label: 'Warranty Claims', icon: 'shield' },
  { page: 'faulty', label: 'Faulty & Supplier', icon: 'wrench' },
  { group: 'reports', label: 'Reports', icon: 'chart', children: ['rsales', 'rpnl', 'rstock', 'rexpenses'] },
];

/* ---------------------------------------------------------------- icons

   One outline set (Heroicons-style, 24px grid, drawn with the text colour),
   inlined so the app keeps working with no internet. The markup asks for one
   by name with x-html="icon('cart')"; nothing reactive goes into it, so each
   is rendered once. */
const ICONS = {
  home: 'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  cart: 'M2.25 3h1.386c.51 0 .955.343 1.087.835l.383 1.437M7.5 14.25a3 3 0 0 0-3 3h15.75m-12.75-3h11.218c1.121-2.3 2.1-4.684 2.924-7.138a60.114 60.114 0 0 0-16.536-1.84M7.5 14.25 5.106 5.272M6 20.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm12.75 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  truck: 'M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12',
  cube: 'm21 7.5-9-5.25L3 7.5m18 0-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9',
  users: 'M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z',
  store: 'M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z',
  banknotes: 'M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z',
  hashtag: 'M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5-3.9 19.5m-2.1-19.5-3.9 19.5',
  shield: 'M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z',
  wrench: 'M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008Z',
  chart: 'M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z',
  search: 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z',
  menu: 'M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5',
  chevronDown: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  chevronRight: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  collapse: 'm18.75 4.5-7.5 7.5 7.5 7.5m-6-15L5.25 12l7.5 7.5',
  expand: 'm5.25 4.5 7.5 7.5-7.5 7.5m6-15 7.5 7.5-7.5 7.5',
  close: 'M6 18 18 6M6 6l12 12',
  plus: 'M12 4.5v15m7.5-7.5h-15',
  logout: 'M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9',
  key: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z',
  warning: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z',
  check: 'M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  error: 'm9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  info: 'm11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z',
  dots: 'M12 6.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 12.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5ZM12 18.75a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z',
  printer: 'M6.72 13.829c-.24.03-.48.062-.72.096m.72-.096a42.415 42.415 0 0 1 10.56 0m-10.56 0L6.34 18m10.94-4.171c.24.03.48.062.72.096m-.72-.096L17.66 18m0 0 .229 2.523a1.125 1.125 0 0 1-1.12 1.227H7.231c-.662 0-1.18-.568-1.12-1.227L6.34 18m11.318 0h1.091A2.25 2.25 0 0 0 21 15.75V9.456c0-1.081-.768-2.015-1.837-2.175a48.055 48.055 0 0 0-1.913-.247M6.34 18H5.25A2.25 2.25 0 0 1 3 15.75V9.456c0-1.081.768-2.015 1.837-2.175a48.041 48.041 0 0 1 1.913-.247m10.5 0a48.536 48.536 0 0 0-10.5 0m10.5 0V3.375c0-.621-.504-1.125-1.125-1.125h-8.25c-.621 0-1.125.504-1.125 1.125v3.659M18 10.5h.008v.008H18V10.5Zm-3 0h.008v.008H15V10.5Z',
  doc: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  trend: 'M2.25 18 9 11.25l4.306 4.306a11.95 11.95 0 0 1 5.814-5.518l2.74-1.22m0 0-5.94-2.281m5.94 2.28-2.28 5.941',
  undo: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3',
  edit: 'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  trash: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',
  refresh: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  barcode: 'M3.75 4.5v15m3-15v15m3.75-15v15m2.25-15v15m3.75-15v15m3.75-15v15',
  user: 'M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  inbox: 'M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z',
  clock: 'M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  arrowRight: 'M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3',
  eye: 'M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  eyeOff: 'M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88',
};

/* Where a row menu goes: under the button that opened it, right-aligned to
   it, flipped above when there is no room below, and never off-screen. The
   menus are fixed elements at the end of <body> — inside a table they would be
   clipped by its scroll box. */
function menuPosition(anchor, width, height) {
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + 4;
  const top = below + height > window.innerHeight ? Math.max(8, r.top - 4 - height) : below;
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
  return { top, left };
}

function iconSvg(name, cls = 'h-5 w-5') {
  const d = ICONS[name];
  if (!d) return '';
  return `<svg class="${cls}" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
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
   invoice of its own instead.

   Returns are hung on the same walk: each invoice gets its `returns` (each
   with its own `lines`), and each sale line the `returned_qty` and
   `returned_amount` that came back against it, so no total below has to
   search the returns again. Warranty claims likewise: `claims` on both the
   invoice and the line, oldest first. */
function buildInvoices(invoices, lines, returns = [], returnLines = [], claims = []) {
  const byId = new Map();
  for (const inv of invoices) byId.set(Number(inv.id), { ...inv, key: `i${inv.id}`, lines: [], returns: [], claims: [] });
  for (const c of claims) byId.get(Number(c.invoice_id))?.claims.push(c);
  const claimsBySale = new Map();
  for (const c of claims) {
    const list = claimsBySale.get(Number(c.sale_id)) || [];
    list.push(c);
    claimsBySale.set(Number(c.sale_id), list);
  }

  const returnsById = new Map();
  for (const r of returns) {
    const ret = { ...r, lines: [] };
    returnsById.set(Number(r.id), ret);
    byId.get(Number(r.invoice_id))?.returns.push(ret);
  }
  const backBySale = new Map();
  for (const rl of returnLines) {
    const ret = returnsById.get(Number(rl.return_id));
    if (!ret) continue;
    ret.lines.push(rl);
    const back = backBySale.get(Number(rl.sale_id)) || { qty: 0, amount: 0 };
    back.qty += Number(rl.quantity || 0);
    back.amount += Number(rl.amount || 0);
    backBySale.set(Number(rl.sale_id), back);
  }
  for (const line of lines) {
    const back = backBySale.get(Number(line.id));
    line.returned_qty = back ? back.qty : 0;
    line.returned_amount = back ? back.amount : 0;
    line.claims = claimsBySale.get(Number(line.id)) || [];
  }

  const orphans = [];
  for (const line of lines) {
    const inv = byId.get(Number(line.invoice_id));
    if (inv) inv.lines.push(line);
    else orphans.push({ ...line, key: `o${line.id}`, lines: [line], returns: [], claims: [] });
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

    // Who is signed in, from /api/session or the login form. Shown in the
    // profile menu; the server's cookie is what actually authorises.
    userEmail: '',

    // ---------------------------------------------------------------- shell
    page: pageFromHash(location.hash),
    pages: PAGES,
    nav: NAV,
    // Sidebar groups unfolded right now. Reassigned, never pushed to: a
    // change inside a nested value was once missed here (the old collapsing
    // sections), while a new top-level value is always picked up.
    navOpenGroups: [],
    sidebarCollapsed: readSidebarCollapsed(),
    // The phone/tablet drawer.
    navOpen: false,
    profileOpen: false,
    alertsOpen: false,

    // Global search (Ctrl+K), over what /api/data has already loaded.
    searchQuery: '',
    searchOpen: false,
    searchIndex: 0,
    // One colour per day on the dashboard's 7-day chart, oldest first; the
    // last is today's, the shop's own green.
    chartColors: [
      ['#4ade80', '#16a34a'], ['#60a5fa', '#2563eb'], ['#c084fc', '#7c3aed'], ['#fbbf24', '#f59e0b'],
      ['#2dd4bf', '#0d9488'], ['#fb923c', '#ea580c'], ['#22c55e', '#166534'],
    ],
    // A field to focus on arriving at the next page, set by a jump (Restock).
    pendingFocus: '',

    // ------------------------------------------------------------ dashboard
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
    // Buying price and Margin (Products & Stock) and Profit (Sales History)
    // start blurred — a customer glancing at the screen should not read the
    // shop's costs or margins off it. marginVisible covers both Buying and
    // Margin, since either one gives the other away. Never persisted: every
    // fresh visit starts hidden again.
    marginVisible: false,
    profitVisible: false,
    /* The desktop sales table's actions menu (Paid / Return / Warranty),
       opened from the arrow beside Print: { inv, top, left } or null.
       One menu for the whole table, positioned under the arrow that opened
       it — see openActionsMenu(). */
    actionsMenu: null,
    // Both start collapsed to five rows; "Show all" opens them fully.
    invLimit: ROWS_COLLAPSED,
    salesLimit: ROWS_COLLAPSED,
    expensesLimit: ROWS_COLLAPSED,
    purchasesLimit: ROWS_COLLAPSED,
    // Exposed so the markup can use the constant instead of repeating the
    // literal 5 — those copies do not follow when the constant changes.
    rowsCollapsed: ROWS_COLLAPSED,

    // Products page: which stock to list — 'all', 'low', 'out' or 'serial'.
    invFilter: 'all',
    // The products table's row menu, placed like actionsMenu: { item, top, left }.
    productMenu: null,

    // Filters on the derived Customers and Suppliers pages.
    customerSearch: '',
    customerDueOnly: false,
    supplierSearch: '',

    sale: blankSale(),
    // The invoice being built: [{ key, item_name, quantity, unit_price, serial_no }].
    cart: [],
    line: blankLine(),
    cartSeq: 0,
    // Invoices with their lines attached — see buildInvoices().
    invoices: [],
    // Returns as the server sends them, flat. buildInvoices() also hangs each
    // on its invoice; these copies are for the date-range totals.
    returns: [],
    returnLines: [],
    /* The Return dialog: { invoice, rows, reason, scan, error, saving } or null.
       Each row is one invoice line: { line, left, qty, condition }. */
    returnDraft: null,
    // Warranty claims, flat as the server sends them; buildInvoices() also
    // hangs each on its invoice and its line.
    claims: [],
    /* The warranty dialog. New claim:
         { kind: 'new', invoice, saleId, qty, problem, replaceNow, code, error, saving }
       Settling an open one:
         { kind: 'resolve', claim, invoice, action, code, note, error, saving } */
    claimDraft: null,
    // Warranty section: every claim, or only the open ones.
    claimFilter: 'open',
    // Faulty stock moved on by hand, and the serials now faulty or at the
    // supplier — see the stock_movements table in server.js.
    movements: [],
    faultyUnits: [],
    /* The faulty-stock dialog: { row, to, qty, party, note, newSerial,
       productId, error, saving } or null. `row` is a faultyQueue entry, or
       null when marking shelf stock faulty, where productId picks the product. */
    moveDraft: null,
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

    // Serial / IMEI page. Fetched page by page from the server, never
    // shipped with /api/data — a year of phones is thousands of rows.
    serialQuery: '',
    serialStatus: 'all',
    serialProductId: '',
    serialRows: [],
    serialTotal: 0,
    serialLoading: false,
    serialLoaded: false,
    // History / remove dialog: { mode, row, events, note, error, saving, loading }.
    // Return opens the invoice's Return dialog instead — see openReturnForSerial().
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
    paymentDraft: { id: null, total: 0, refunded: 0, paid_amount: '' },
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

      // The address bar is the router: back/forward and a pasted link both
      // arrive here.
      window.addEventListener('hashchange', () => this.enterPage(pageFromHash(location.hash)));
      this.enterPage(this.page, { initial: true });

      try {
        const res = await fetch('/api/session');
        const data = await res.json().catch(() => ({}));
        if (data.authenticated) {
          this.isLoggedIn = true;
          this.userEmail = data.email || '';
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

    /* ---------------------------------------------------------------- shell */

    // Navigate. Goes through the address bar so back/forward work, except
    // when already on the page — the hash would not change, and the caller
    // (a jump from another page, say) still wants the page entered afresh.
    go(name) {
      if (!PAGES[name]) name = 'dashboard';
      this.navOpen = false;
      this.profileOpen = false;
      this.alertsOpen = false;
      if (name === this.page) {
        this.enterPage(name);
        return;
      }
      location.hash = `#/${PAGES[name].hash}`;
    },

    // Everything that happens on arriving at a page, however it was reached.
    enterPage(name, { initial = false } = {}) {
      this.page = PAGES[name] ? name : 'dashboard';
      this.navOpen = false;
      this.actionsMenu = null;
      this.productMenu = null;
      // The page's own group unfolds, and the ones it left fold away, so the
      // sidebar never grows into a list of every page visited.
      const group = PAGES[this.page].group;
      if (group) this.navOpenGroups = [group];
      this.baseTitle = `${PAGES[this.page].title} — ${this.shop?.name || 'NetBazar'}`;
      if (!this.isReceiptOpen) document.title = this.baseTitle;
      if (!initial) window.scrollTo({ top: 0 });

      // The serial list is fetched on demand, not with the dashboard — see
      // GET /api/serials — so arriving on its page is what loads it.
      if (this.page === 'serials' && !this.serialLoaded && this.isLoggedIn) this.loadSerials();

      // The two tills open ready for the scanner: a shopkeeper with a box in
      // one hand should never have to click into the barcode field first. A
      // jump that already knows the next field (Restock) names it instead.
      const focus = this.pendingFocus || { sale: 'scanInput', purchase: 'dealerScan' }[this.page];
      this.pendingFocus = '';
      if (focus) this.focusWhenShown(focus);
    },

    /* Focus a ref once its page is on screen. x-show reveals a panel on the
       next animation frame (setTimeout in a background tab), after nextTick,
       and focus() on a field that is still display:none does nothing — so
       wait for it to have a box, a few frames at most. */
    focusWhenShown(ref, tries = 10) {
      this.$nextTick(() => {
        const step = (left) => {
          const el = this.$refs[ref];
          if (!el) return;
          if (el.offsetParent !== null) el.focus();
          else if (left > 0) (document.visibilityState === 'visible' ? requestAnimationFrame : setTimeout)(() => step(left - 1));
        };
        step(tries);
      });
    },

    pageTitle(name) {
      return PAGES[name]?.title || '';
    },

    // The group a page sits in, for highlighting its parent in the sidebar.
    pageGroup(name) {
      return PAGES[name]?.group || '';
    },

    toggleNavGroup(group) {
      this.navOpenGroups = this.navOpenGroups.includes(group)
        ? this.navOpenGroups.filter((g) => g !== group)
        : [...this.navOpenGroups, group];
    },

    // A folded sidebar has no room for a group's children, so its icon goes
    // straight to the group's first page instead.
    openNavGroup(item) {
      if (this.sidebarCollapsed && window.matchMedia('(min-width: 1024px)').matches) {
        this.go(item.children[0]);
        return;
      }
      this.toggleNavGroup(item.group);
    },

    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      writeSidebarCollapsed(this.sidebarCollapsed);
    },

    // A count beside a menu item, only where something is waiting on the shop.
    navCount(name) {
      if (name === 'lowstock') return this.lowStockItems.length;
      if (name === 'warranty') return this.openClaimCount;
      if (name === 'faulty') return this.faultyQueue.length;
      return 0;
    },

    icon: iconSvg,

    // Dashboard quick action: the expense form, ready to type.
    newExpense() {
      this.pendingFocus = 'expCategory';
      this.go('expenses');
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
       no button is highlighted and rangeLabel spells the dates out. The
       presets are 1, 7 and 30 days long, so no two ever share a range. */
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

    // Today's sales less today's returns, whichever day those were sold.
    get todaysRevenue() {
      return this.todaysSales.reduce((sum, inv) => sum + this.invoiceTotal(inv), 0) - this.todaysReturns;
    },

    get todaysReturns() {
      const t = todayLocal();
      const today = new Set(this.returns.filter((r) => r.date === t).map((r) => Number(r.id)));
      return this.returnLines
        .filter((rl) => today.has(Number(rl.return_id)))
        .reduce((sum, rl) => sum + Number(rl.amount || 0), 0);
    },

    /* ----------------------------------------------------------- invoices */

    // What the lines came to when sold — the receipt's Sub Total. Returns never
    // change it; they are taken off below it, as invoiceNet().
    invoiceTotal(inv) {
      return (inv?.lines || []).reduce((sum, l) => sum + Number(l.total_price || 0), 0);
    },

    /* ------------------------------------------------------------ returns

       One definition of an invoice's money after returns, mirrored by
       invoiceMoney() on the server:
         net  = sold − returned
         paid = handed over − refunded
         due  = net − paid */

    invoiceReturned(inv) {
      return (inv?.lines || []).reduce((sum, l) => sum + Number(l.returned_amount || 0), 0);
    },

    invoiceRefunded(inv) {
      return (inv?.returns || []).reduce((sum, r) => sum + Number(r.refund_amount || 0), 0);
    },

    invoiceHasReturns(inv) {
      return (inv?.returns || []).length > 0;
    },

    invoiceNet(inv) {
      return this.invoiceTotal(inv) - this.invoiceReturned(inv);
    },

    // Units on a line not yet returned.
    lineLeft(l) {
      return Number(l.quantity || 0) - Number(l.returned_qty || 0);
    },

    // Nothing left to return: every unit on every line came back.
    invoiceFullyReturned(inv) {
      return (inv?.lines || []).every((l) => this.lineLeft(l) <= 0);
    },

    /* Opens the actions menu under the arrow that was clicked, or closes it
       if that row's menu is already open.

       The menu lives at the top of <body>, not in the row: the table scrolls
       sideways inside an overflow box that would clip anything hanging out of
       it, and the sections' rise animation leaves a transform behind that
       would pin a `fixed` element to the section instead of the viewport. So
       it is placed from the arrow's on-screen position, and flips above the
       arrow when there is no room below. */
    openActionsMenu(inv, event) {
      if (Number(this.actionsMenu?.inv.id) === Number(inv.id)) {
        this.actionsMenu = null;
        return;
      }
      this.productMenu = null;
      // Three items; the height is used only to decide on flipping.
      this.actionsMenu = { inv, ...menuPosition(event.currentTarget, 160, 130) };
    },

    closeActionsMenu() {
      this.actionsMenu = null;
    },

    // The products table's ⋯ menu, on the same footing as the one above.
    openProductMenu(item, event) {
      if (Number(this.productMenu?.item.id) === Number(item.id)) {
        this.productMenu = null;
        return;
      }
      this.actionsMenu = null;
      this.productMenu = { item, ...menuPosition(event.currentTarget, 176, 170) };
    },

    runProductMenu(name) {
      const item = this.productMenu?.item;
      this.productMenu = null;
      if (!item) return;
      if (name === 'delete') {
        this.openEditProduct(item);
        this.confirmDelete = true;
      } else if (name === 'markFaulty') {
        // Counted goods only; the dialog's product picker starts on this one.
        this.openMarkFaulty();
        this.moveDraft.productId = String(item.id);
      } else {
        this[name](item);
      }
    },

    // Runs a menu item on the menu's invoice, closing the menu first. Takes
    // the method's name, not the method, so it is called with `this` intact.
    runMenuAction(name) {
      const inv = this.actionsMenu?.inv;
      this.actionsMenu = null;
      if (inv) this[name](inv);
    },

    // The profit a return takes back: what that share of the line earned. Null
    // when the line's cost is unknown, since its profit was never counted.
    returnLineProfit(rl) {
      if (rl?.cost_price == null || rl.cost_price === '') return null;
      const cost = Number(rl.cost_price);
      if (!Number.isFinite(cost)) return null;
      return Number(rl.amount || 0) - cost * Number(rl.quantity || 0);
    },

    returnProfitOf(rows) {
      return rows.reduce((sum, rl) => sum + (this.returnLineProfit(rl) ?? 0), 0);
    },

    // "Returned 8" under a line on the receipt and in the history.
    returnedText(l) {
      const n = Number(l?.returned_qty || 0);
      if (!n) return '';
      return n >= Number(l.quantity || 0) ? 'Returned' : `Returned ${n} of ${l.quantity}`;
    },

    // Profit on the lines whose cost is known, less what returns took back;
    // null when none of the lines are costed.
    invoiceProfit(inv) {
      const known = (inv?.lines || []).map((l) => this.saleProfit(l)).filter((p) => p !== null);
      if (!known.length) return null;
      const back = (inv.returns || []).reduce((sum, r) => sum + this.returnProfitOf(r.lines), 0);
      return known.reduce((a, b) => a + b, 0) - back;
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

    // Everything the customer has handed over, refunds not taken off. This is
    // what paid_amount stores, and what the payment endpoint takes.
    invoicePaidIn(inv) {
      return this.invoiceTracksPayment(inv) ? Number(inv.paid_amount) : this.invoiceTotal(inv);
    },

    // What the shop has kept: paid in, less refunds.
    invoicePaid(inv) {
      return this.invoicePaidIn(inv) - this.invoiceRefunded(inv);
    },

    invoiceDue(inv) {
      return Math.max(0, this.invoiceNet(inv) - this.invoicePaid(inv));
    },

    // Same epsilon as the server's validatePaidAmount: a total summed from
    // floats leaves a few thousandths behind, and a receipt settled to the last
    // taka must not sit in the Due list forever because of them.
    isInvoiceDue(inv) {
      return this.invoiceDue(inv) > PAID_EPSILON;
    },

    /* The one-word state of an invoice for the status column. An invoice from
       before dues were tracked gets no word at all — see invoiceTracksPayment
       — rather than a PAID the shop cannot stand behind. */
    invoiceStatus(inv) {
      if (this.invoiceFullyReturned(inv)) return { label: 'Returned', tone: 'is-neutral' };
      if (this.isInvoiceDue(inv)) return { label: 'Due', tone: 'is-danger' };
      if (this.invoiceTracksPayment(inv)) return { label: 'Paid', tone: 'is-success' };
      return null;
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
      return this.sales.reduce((sum, s) => sum + Number(s.total_price || 0), 0)
        - this.returnLines.reduce((sum, rl) => sum + Number(rl.amount || 0), 0);
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

    /* ------------------------------------------------------ list lengths */

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
      return this.inventory.filter((i) => {
        if (this.invFilter === 'low' && !this.isLowStock(i)) return false;
        if (this.invFilter === 'out' && Number(i.quantity) > 0) return false;
        if (this.invFilter === 'serial' && !this.serialTracked(i)) return false;
        if (!q) return true;
        return (
          (i.item_name || '').toLowerCase().includes(q) ||
          String(i.barcode || '').toLowerCase().includes(q)
        );
      });
    },

    // In stock / Low / Out, as a word and a badge tone.
    stockStatus(item) {
      const qty = Number(item?.quantity || 0);
      if (qty <= 0) return { label: 'Out of stock', tone: 'is-danger' };
      if (this.isLowStock(item)) return { label: 'Low stock', tone: 'is-warning' };
      return { label: 'In stock', tone: 'is-success' };
    },

    // Fewest units first: the most urgent restock at the top.
    get lowStockSorted() {
      return [...this.lowStockItems].sort((a, b) => Number(a.quantity) - Number(b.quantity) || a.item_name.localeCompare(b.item_name));
    },

    // Search matches the invoice number, customer, phone, comment, or any item
    // or serial on the invoice — "who bought the ONU modem last week?" has to
    // work, and so does a customer turning up with a dead fan and its serial.
    get filteredInvoices() {
      return this.invoices.filter((inv) => this.inDateRange(inv) && this.matchesSaleFilters(inv));
    },

    // The search box and the Due / Paid chips — everything but the dates, so
    // returns can be matched by their own date and still follow the rest.
    matchesSaleFilters(inv) {
      // The Due / Paid chips. Left out of the search box on purpose: typing
      // "due" should still find a customer's note that says so.
      if (this.saleStatus === 'due' && !this.isInvoiceDue(inv)) return false;
      if (this.saleStatus === 'paid' && this.isInvoiceDue(inv)) return false;
      const q = this.saleSearch.trim().toLowerCase();
      if (!q) return true;
      const hay = [inv.id, inv.customer_name || 'Walk-in', inv.customer_contact, inv.comment]
        .map((v) => String(v ?? '').toLowerCase());
      return (
        hay.some((v) => v.includes(q)) ||
        inv.lines.some(
          (l) =>
            (l.item_name || '').toLowerCase().includes(q) ||
            String(l.serial_no || '').toLowerCase().includes(q)
        ) ||
        // A customer holding a warranty replacement has that unit's serial,
        // not the one printed at the sale.
        (inv.claims || []).some((c) => String(c.replacement_serial_no || '').toLowerCase().includes(q))
      );
    },

    /* Returns made inside the date range, dated by the day the goods came back
       rather than the day they were sold. That is what keeps a past day's
       figures from changing: yesterday's sale stays yesterday's, and today
       shows the return — even when that takes today below zero, which is
       then what really happened at the counter. */
    get filteredReturns() {
      return this.invoices
        .filter((inv) => inv.returns.length && this.matchesSaleFilters(inv))
        .flatMap((inv) => inv.returns.filter((r) => this.inDateRange(r)));
    },

    get rangeReturns() {
      return this.filteredReturns.reduce((sum, r) => sum + r.lines.reduce((s, rl) => s + Number(rl.amount || 0), 0), 0);
    },

    get rangeRefunds() {
      return this.filteredReturns.reduce((sum, r) => sum + Number(r.refund_amount || 0), 0);
    },

    get rangeNetSales() {
      return this.rangeRevenue - this.rangeReturns;
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

    // Less the profit on anything returned in the range — see filteredReturns.
    get rangeProfit() {
      return this.profitOf(this.filteredLines) - this.filteredReturns.reduce((sum, r) => sum + this.returnProfitOf(r.lines), 0);
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
      return this.rangeProfit - this.rangeExpenses - this.rangeWriteOffs;
    },

    // What a move cost the shop: only a write-off does, at the buying price
    // snapshotted on the move. Anything else is stock changing place.
    movementLoss(m) {
      if (m?.to_state !== 'written_off' || m.cost_price == null || m.cost_price === '') return 0;
      return Number(m.cost_price) * Number(m.quantity || 0);
    },

    // Stock written off in the range, on the day it was written off.
    get rangeWriteOffs() {
      return this.movements.filter((m) => this.inDateRange(m)).reduce((sum, m) => sum + this.movementLoss(m), 0);
    },

    get totalWriteOffs() {
      return this.movements.reduce((sum, m) => sum + this.movementLoss(m), 0);
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
      return this.totalSalesProfit - this.totalExpenses - this.totalWriteOffs;
    },

    // Profit on every sale ever, less what returns took back.
    get totalSalesProfit() {
      return this.profitOf(this.sales) - this.returnProfitOf(this.returnLines);
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

    /* ---------------------------------------------------- derived pages

       Customers, Suppliers and the reports are views over data /api/data has
       already loaded — there is no customer or supplier table behind them.
       Every figure goes through the same invoice and range functions the
       sales list uses, so a report can never disagree with the ledger. */

    /* One row per customer, as the invoices name them. A phone number is the
       firmest identity a walk-in shop has, so invoices sharing one are one
       customer whatever the name was typed as; without a phone, the name is.
       Invoices with neither are the walk-in counter trade, kept as one row. */
    get customers() {
      const byKey = new Map();
      for (const inv of this.invoices) {
        const name = String(inv.customer_name || '').trim();
        const contact = String(inv.customer_contact || '').trim();
        const key = contact ? `c:${contact}` : name ? `n:${name.toLowerCase()}` : 'walk-in';
        let row = byKey.get(key);
        if (!row) {
          row = { key, name: '', contact, walkIn: key === 'walk-in', invoices: 0, total: 0, paid: 0, due: 0, last: '' };
          byKey.set(key, row);
        }
        row.invoices += 1;
        row.total += this.invoiceNet(inv);
        row.paid += this.invoicePaid(inv);
        row.due += this.invoiceDue(inv);
        // The name on their most recent invoice.
        if ((inv.date || '') >= row.last) {
          row.last = inv.date || '';
          if (name) row.name = name;
        }
      }
      return [...byKey.values()].sort((a, b) => b.last.localeCompare(a.last) || b.total - a.total);
    },

    get filteredCustomers() {
      const q = this.customerSearch.trim().toLowerCase();
      return this.customers.filter((c) => {
        if (this.customerDueOnly && c.due <= PAID_EPSILON) return false;
        if (!q) return true;
        return (c.name || 'walk-in').toLowerCase().includes(q) || c.contact.toLowerCase().includes(q);
      });
    },

    get customersDueTotal() {
      return this.customers.reduce((sum, c) => sum + c.due, 0);
    },

    // A customer's invoices, on the sales page: searched by phone if there is
    // one (the name may be spelled several ways), over all time, any status.
    openCustomerSales(c) {
      this.saleSearch = c.walkIn ? 'Walk-in' : c.contact || c.name;
      this.saleStatus = 'all';
      this.setDateRange('all');
      this.go('sales');
    },

    // One row per dealer name, as the purchases record it. Purchases carry no
    // paid amount, so there is no supplier due to show — only what was bought.
    get suppliers() {
      const byKey = new Map();
      for (const p of this.purchases) {
        const name = String(p.dealer_name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        let row = byKey.get(key);
        if (!row) {
          row = { key, name, batches: 0, units: 0, spend: 0, last: '', items: new Set() };
          byKey.set(key, row);
        }
        row.batches += 1;
        row.units += Number(p.quantity || 0);
        row.spend += Number(p.total_cost || 0);
        if (p.item_name) row.items.add(p.item_name);
        if ((p.date || '') >= row.last) row.last = p.date || '';
      }
      return [...byKey.values()]
        .map((r) => ({ ...r, items: r.items.size }))
        .sort((a, b) => b.last.localeCompare(a.last) || b.spend - a.spend);
    },

    get filteredSuppliers() {
      const q = this.supplierSearch.trim().toLowerCase();
      if (!q) return this.suppliers;
      return this.suppliers.filter((s) => s.name.toLowerCase().includes(q));
    },

    openSupplierPurchases(s) {
      this.dealerSearch = s.name;
      this.go('purchases');
    },

    /* The selected range, day by day. Built from exactly the rows the range
       totals sum — filteredInvoices, filteredReturns, filteredExpenses and the
       range's stock moves — so the days always add up to the totals above
       them. Returns sit on the day the goods came back, as they do there. */
    get reportDays() {
      const days = new Map();
      const day = (date) => {
        const d = date || '';
        if (!days.has(d)) {
          days.set(d, { date: d, invoices: 0, sold: 0, returns: 0, profit: 0, discount: 0, due: 0, expenses: 0, writeOffs: 0 });
        }
        return days.get(d);
      };
      for (const inv of this.filteredInvoices) {
        const r = day(inv.date);
        r.invoices += 1;
        r.sold += this.invoiceTotal(inv);
        r.profit += this.profitOf(inv.lines);
        r.discount += this.invoiceDiscount(inv);
        r.due += this.invoiceDue(inv);
      }
      for (const ret of this.filteredReturns) {
        const r = day(ret.date);
        r.returns += ret.lines.reduce((s, rl) => s + Number(rl.amount || 0), 0);
        r.profit -= this.returnProfitOf(ret.lines);
      }
      for (const e of this.filteredExpenses) day(e.date).expenses += Number(e.amount || 0);
      for (const m of this.movements) {
        const loss = this.movementLoss(m);
        if (loss && this.inDateRange(m)) day(m.date).writeOffs += loss;
      }
      return [...days.values()]
        .map((r) => ({ ...r, net: r.profit - r.expenses - r.writeOffs }))
        .sort((a, b) => b.date.localeCompare(a.date));
    },

    // Whether a sales-page filter is narrowing the report, so it can say so.
    get reportFilterNote() {
      const parts = [];
      if (this.saleSearch.trim()) parts.push(`sales matching “${this.saleSearch.trim()}”`);
      if (this.saleStatus !== 'all') parts.push(this.saleStatus === 'due' ? 'due invoices only' : 'paid invoices only');
      if (this.expenseSearch.trim()) parts.push(`expenses matching “${this.expenseSearch.trim()}”`);
      return parts.join(', ');
    },

    clearReportFilters() {
      this.saleSearch = '';
      this.saleStatus = 'all';
      this.expenseSearch = '';
    },

    // Stock by product, most money on the shelf first.
    get stockRows() {
      return [...this.inventory]
        .map((i) => ({
          ...i,
          costValue: Number(i.cost_price || 0) * Number(i.quantity || 0),
          saleValue: Number(i.selling_price || 0) * Number(i.quantity || 0),
          potential: this.itemMargin(i) * Number(i.quantity || 0),
        }))
        .sort((a, b) => b.costValue - a.costValue);
    },

    get stockSaleValue() {
      return this.stockRows.reduce((sum, r) => sum + r.saleValue, 0);
    },

    /* The last seven days' takings, for the dashboard chart: each day's sales
       less the returns made that day — todaysRevenue's definition, for every
       day, so today's bar is exactly the Today's Sales card. */
    get last7Days() {
      const pad = (n) => String(n).padStart(2, '0');
      const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
      const returnDate = new Map(this.returns.map((r) => [Number(r.id), r.date]));
      const days = [];
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push({ date: iso(d), label: d.toLocaleDateString('en-GB', { weekday: 'short' }), sold: 0, returns: 0, invoices: 0 });
      }
      const byDate = new Map(days.map((d) => [d.date, d]));
      for (const inv of this.invoices) {
        const d = byDate.get(inv.date);
        if (d) {
          d.sold += this.invoiceTotal(inv);
          d.invoices += 1;
        }
      }
      for (const rl of this.returnLines) {
        const d = byDate.get(returnDate.get(Number(rl.return_id)));
        if (d) d.returns += Number(rl.amount || 0);
      }
      const rows = days.map((d) => ({ ...d, net: d.sold - d.returns }));
      const max = Math.max(1, ...rows.map((r) => r.net));
      return rows.map((r) => ({ ...r, pct: Math.max(0, (r.net / max) * 100) }));
    },

    get last7Total() {
      return this.last7Days.reduce((sum, d) => sum + d.net, 0);
    },

    // The very first load, before anything has arrived: the moment for
    // skeletons rather than "nothing here yet".
    get firstLoad() {
      return this.loading && !this.invoices.length && !this.inventory.length;
    },

    get recentInvoices() {
      return [...this.invoices]
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || Number(b.id) - Number(a.id))
        .slice(0, 6);
    },

    get recentPurchases() {
      return this.purchases.slice(0, 5);
    },

    /* ------------------------------------------------------- global search

       Ctrl+K from anywhere. Searches what is already in memory — products,
       invoices, customers, suppliers and the pages themselves — and offers a
       serial lookup, which goes to the Serial page's server-side search. */
    get searchResults() {
      const q = this.searchQuery.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      const has = (v) => String(v ?? '').toLowerCase().includes(q);

      for (const [name, p] of Object.entries(PAGES)) {
        if (has(p.title)) out.push({ kind: 'Pages', key: `pg-${name}`, label: p.title, sub: 'Go to page', run: () => this.go(name) });
      }
      const num = q.replace(/^#/, '');
      this.inventory
        .filter((i) => has(i.item_name) || has(i.barcode))
        .slice(0, 5)
        .forEach((i) => out.push({
          kind: 'Products', key: `p-${i.id}`, label: i.item_name,
          sub: `${i.quantity} in stock · ${this.fmt(i.selling_price)}${i.barcode ? ' · ' + i.barcode : ''}`,
          run: () => { this.invSearch = i.item_name; this.go('products'); },
        }));
      this.invoices
        .filter((inv) => String(inv.id) === num || has(inv.customer_name) || has(inv.customer_contact))
        .slice(0, 5)
        .forEach((inv) => out.push({
          kind: 'Invoices', key: `i-${inv.id}`, label: `#${inv.id} · ${inv.customer_name || 'Walk-in'}`,
          sub: `${this.fmtDate(inv.date)} · ${this.fmt(this.invoiceNet(inv))}${this.isInvoiceDue(inv) ? ' · Due ' + this.fmt(this.invoiceDue(inv)) : ''}`,
          run: () => this.showReceipt(inv),
        }));
      this.customers
        .filter((c) => !c.walkIn && (has(c.name) || has(c.contact)))
        .slice(0, 3)
        .forEach((c) => out.push({
          kind: 'Customers', key: `c-${c.key}`, label: c.name || c.contact, sub: [c.contact, `${c.invoices} invoice(s)`].filter(Boolean).join(' · '),
          run: () => this.openCustomerSales(c),
        }));
      this.suppliers
        .filter((s) => has(s.name))
        .slice(0, 3)
        .forEach((s) => out.push({
          kind: 'Suppliers', key: `s-${s.key}`, label: s.name, sub: `${s.batches} purchase(s)`,
          run: () => this.openSupplierPurchases(s),
        }));
      const code = this.searchQuery.trim();
      out.push({
        kind: 'Serial / IMEI', key: 'serial', label: `Find serial “${code}”`, sub: 'Search every unit on the Serial / IMEI page',
        run: () => {
          this.serialQuery = code;
          this.serialProductId = '';
          this.serialStatus = 'all';
          this.serialLoaded = false;
          this.go('serials');
        },
      });
      return out;
    },

    // Focused at once, not on the next tick: the box is always on screen,
    // and a shopkeeper typing straight after Ctrl+K must not lose letters.
    openSearch() {
      this.searchOpen = true;
      this.searchIndex = 0;
      this.$refs.globalSearch?.focus();
      this.$refs.globalSearch?.select();
    },

    closeSearch() {
      this.searchOpen = false;
      this.searchQuery = '';
      this.searchIndex = 0;
    },

    moveSearch(step) {
      const n = this.searchResults.length;
      if (!n) return;
      this.searchIndex = (this.searchIndex + step + n) % n;
      this.$nextTick(() => document.getElementById(`sr-${this.searchIndex}`)?.scrollIntoView({ block: 'nearest' }));
    },

    runSearch(i = this.searchIndex) {
      const hit = this.searchResults[i];
      if (!hit) return;
      this.closeSearch();
      this.$refs.globalSearch?.blur();
      hit.run();
    },

    // A product off the stock lists, loaded into the purchase form.
    restockProduct(item) {
      this.dealer.barcode = item.barcode || '';
      this.pendingFocus = this.fillDealerFrom(item);
      this.go('purchase');
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
          this.userEmail = this.loginEmail.trim().toLowerCase();
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
      this.userEmail = '';
      this.profileOpen = false;
      this.searchQuery = '';
      this.searchOpen = false;
      this.serialRows = [];
      this.serialLoaded = false;
      this.isReceiptOpen = false;
      this.isProductOpen = false;
      this.loginEmail = '';
      this.loginPassword = '';
      this.sales = [];
      this.invoices = [];
      this.returns = [];
      this.returnLines = [];
      this.returnDraft = null;
      this.claims = [];
      this.claimDraft = null;
      this.movements = [];
      this.faultyUnits = [];
      this.moveDraft = null;
      this.actionsMenu = null;
      this.productMenu = null;
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
        this.returns = data.returns || [];
        this.returnLines = data.return_lines || [];
        this.claims = data.warranty_claims || [];
        this.movements = data.stock_movements || [];
        this.faultyUnits = data.faulty_units || [];
        this.invoices = buildInvoices(data.invoices || [], this.sales, this.returns, this.returnLines, this.claims);
        this.purchases = data.purchases || [];
        this.expenses = data.expenses || [];
        // A sale or a return changes serial statuses too. Refetched now when
        // the list is on screen; otherwise marked stale for the next visit.
        if (this.page === 'serials') this.loadSerials();
        else this.serialLoaded = false;
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
    async scanBarcode() {
      const code = String(this.scanCode || '').trim();
      if (!code) return;
      if (this.repeatScan('barcode', code)) {
        this.scanCode = '';
        return;
      }

      const item = this.findByBarcode(code);
      if (!item) {
        /* Focus rests here between items, so a unit's serial label is often
           scanned into this box first. A registered serial says which product
           it is, so it is sold as though it had gone into the serial box. */
        const found = await this.lookupSerial(code);
        if (found === undefined) return;
        if (found) {
          this.unknownBarcode = '';
          this.scanCode = '';
          if (this.cart.find((l) => sameCode(l.serial_no, code))) {
            this.scanFailed(`${code} is already on this invoice.`);
            return;
          }
          this.applySerial(code, found);
          return;
        }
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

    // Units back from customers faulty — kept, but not in stock. Faulty serials
    // plus defective_quantity: goods without serials, and units of a tracked
    // product sold before it was tracked, which have no serial to mark.
    faultyCount(item) {
      return Number(item?.defective_serials || 0) + Number(item?.defective_quantity || 0);
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

      const found = await this.lookupSerial(code);
      if (found === undefined) return;
      this.applySerial(code, found);
    },

    /* The registered serial `code`, null if there is none, or undefined when
       the server could not be asked — already reported to the cashier. */
    async lookupSerial(code) {
      try {
        const res = await fetch(`/api/serials/lookup?code=${encodeURIComponent(code)}`);
        if (res.ok) return await res.json();
        if (res.status === 404) return null;
        throw new Error(await this.describeFailure(res, 'Could not check the serial.'));
      } catch (err) {
        this.scanFailed(`${err.message || 'Could not check the serial.'} Scan it again.`);
        return undefined;
      }
    },

    // Put a scanned serial on the invoice, given what the server knows of it.
    applySerial(code, found) {
      this.serialOverride = null;

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
        if (found.status !== 'available') {
          const where = {
            defective: 'is faulty and kept aside',
            at_supplier: 'is at the supplier',
            written_off: 'was written off',
            exchanged: 'was exchanged by the supplier',
          }[found.status] || 'is not in stock';
          this.scanFailed(`${found.serial_no} ${where} — not for sale.`);
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

      // Nothing says which product this is: the barcode has to come first.
      if (!target) {
        this.scanFailed('First scan the barcode please.');
        this.$nextTick(() => this.$refs.scanInput?.focus());
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
        const next = this.fillDealerFrom(item);
        if (this.serialTracked(item)) this.scanOk(`${item.item_name} (${item.quantity} in stock) — scan each unit's serial.`);
        else this.scanOk(`Restocking ${item.item_name}.`);
        this.$nextTick(() => this.$refs[next]?.focus());
      } else {
        this.dealerBatch = blankBatch();
        this.scanOk(`New barcode ${code} — fill in the product details.`);
        this.$nextTick(() => this.$refs.dealerItem?.focus());
      }
    },

    // Loads a known product into the dealer form for restocking, and names
    // the field to type in next: its serials if it has them, else the count.
    fillDealerFrom(item) {
      this.dealer.item_name = item.item_name;
      this.dealer.cost_price = item.cost_price;
      this.dealer.selling_price = item.selling_price;
      this.dealer.warranty_months = item.warranty_months ?? 0;
      if (this.dealerBatch.item_name !== item.item_name) this.dealerBatch = blankBatch();
      return this.serialTracked(item) ? 'dealerSerial' : 'dealerQty';
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
       lines on every keystroke.

       After a return the dialog speaks in what the customer now owes and has
       kept paid — the net total, refunds already taken off — because that is
       what the shopkeeper is looking at on the receipt. `refunded` is added back
       on save, since paid_amount stores everything handed over. */
    openPayment(inv) {
      const cents = (n) => Math.round(n * 100) / 100;
      this.paymentDraft = {
        id: inv.id,
        customer_name: inv.customer_name,
        total: cents(this.invoiceNet(inv)),
        refunded: this.invoiceRefunded(inv),
        paid_amount: cents(this.invoicePaid(inv)),
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
          body: JSON.stringify({
            paid_amount: String(this.paymentDraft.paid_amount).trim() === ''
              ? ''
              : Number(this.paymentDraft.paid_amount) + Number(this.paymentDraft.refunded || 0),
          }),
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

    /* -------------------------------------------- return against an invoice

       Goods coming back, full or part. The dialog lists each line with
       something left to return; a line of one unit (every serial line is one)
       is a tick box, any other a quantity. The refund is not typed: it is
       whatever the customer has paid beyond the invoice's new total, worked
       out here to show and again on the server, which is the one that counts. */

    openReturn(inv, { saleId = null } = {}) {
      const rows = (inv?.lines || [])
        .map((line) => ({
          line,
          // Not what is in the shop on an open warranty claim — the server
          // refuses that until the claim is settled.
          left: this.lineWithCustomer(line),
          qty: saleId != null && Number(line.id) === Number(saleId) ? 1 : 0,
          condition: 'good',
        }))
        .filter((r) => r.left > 0);
      if (!rows.length) {
        this.notify('Nothing on this invoice is left to return — it has all come back, or is in on a warranty claim.', 'error');
        return;
      }
      this.returnDraft = { invoice: inv, rows, reason: '', scan: '', error: '', saving: false };
    },

    // The serial list's Return button: the unit's invoice, that line ticked.
    openReturnForSerial(row) {
      const inv = this.invoices.find((i) => Number(i.id) === Number(row.invoice_id));
      if (!inv) {
        this.notify(`Invoice #${row.invoice_id} is not loaded.`, 'error');
        return;
      }
      this.openReturn(inv, { saleId: row.sale_id });
    },

    closeReturn() {
      this.returnDraft = null;
    },

    // What this row gives back. The last units take whatever of the line's
    // price is left, exactly as recordReturn() does on the server.
    returnRowAmount(row) {
      const qty = Number(row.qty) || 0;
      if (qty <= 0) return 0;
      const price = Number(row.line.total_price || 0);
      const amount = qty >= this.lineLeft(row.line)
        ? price - Number(row.line.returned_amount || 0)
        : (price * qty) / Number(row.line.quantity || 1);
      return Math.round(amount * 100) / 100;
    },

    get returnAmount() {
      return (this.returnDraft?.rows || []).reduce((sum, r) => sum + this.returnRowAmount(r), 0);
    },

    get returnNewNet() {
      return this.returnDraft ? this.invoiceNet(this.returnDraft.invoice) - this.returnAmount : 0;
    },

    get returnRefund() {
      if (!this.returnDraft) return 0;
      const over = Math.round((this.invoicePaid(this.returnDraft.invoice) - this.returnNewNet) * 100) / 100;
      return over > PAID_EPSILON ? over : 0;
    },

    get returnNewDue() {
      if (!this.returnDraft) return 0;
      const kept = this.invoicePaid(this.returnDraft.invoice) - this.returnRefund;
      return Math.max(0, this.returnNewNet - kept);
    },

    get returnChosen() {
      return (this.returnDraft?.rows || []).filter((r) => Number(r.qty) > 0);
    },

    // A serial scanned into the dialog ticks its line.
    scanReturnSerial() {
      const dlg = this.returnDraft;
      const code = String(dlg?.scan || '').trim();
      if (!dlg || !code) return;
      dlg.scan = '';
      const row = dlg.rows.find((r) => sameCode(r.line.serial_no, code));
      if (!row) {
        dlg.error = `${code} is not on invoice #${dlg.invoice.id}, or it already came back.`;
        return;
      }
      dlg.error = '';
      row.qty = 1;
    },

    async submitReturn() {
      const dlg = this.returnDraft;
      if (!dlg || dlg.saving) return;
      const chosen = this.returnChosen;
      if (!chosen.length) {
        dlg.error = 'Tick or enter what came back.';
        return;
      }
      const bad = chosen.find((r) => !Number.isInteger(Number(r.qty)) || Number(r.qty) > r.left);
      if (bad) {
        dlg.error = `${bad.line.item_name}: return a whole number, at most ${bad.left}.`;
        return;
      }
      dlg.saving = true;
      dlg.error = '';
      try {
        const res = await fetch(`/api/invoices/${dlg.invoice.id}/returns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason: dlg.reason,
            lines: chosen.map((r) => ({ sale_id: r.line.id, quantity: Number(r.qty), condition: r.condition })),
          }),
        });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not record the return.'));
        const out = await res.json();
        const id = dlg.invoice.id;
        this.returnDraft = null;
        this.notify(
          Number(out.refund_amount) > 0
            ? `Return recorded. Give ${this.fmt(out.refund_amount)} back to the customer.`
            : 'Return recorded.'
        );
        await this.loadData({ quiet: true });
        // The receipt behind this dialog holds the invoice from before the
        // reload; swap in the fresh one so it shows the return straight away.
        if (Number(this.currentReceipt?.id) === Number(id)) {
          const fresh = this.invoices.find((inv) => Number(inv.id) === Number(id));
          if (fresh) this.currentReceipt = fresh;
        }
      } catch (err) {
        dlg.error = err.message || 'Could not record the return.';
      } finally {
        dlg.saving = false;
      }
    },

    /* ------------------------------------------------------ warranty claims

       A claim never touches money: the replacement goes out against the
       original sale line, so the invoice, its total and its profit all stay
       as they were. What the customer holds, and when its warranty ends, is
       read from the line and the claims on it. */

    // Units of a line in the shop on claims not yet settled.
    lineOpenClaimQty(l) {
      return (l?.claims || []).filter((c) => c.status === 'open').reduce((sum, c) => sum + Number(c.quantity || 0), 0);
    },

    // Units of a line the customer still holds: not returned, not in on a claim.
    lineWithCustomer(l) {
      return this.lineLeft(l) - this.lineOpenClaimQty(l);
    },

    // The serial the customer holds on this line now: the one sold, or the
    // last replacement given for it.
    lineSerialNow(l) {
      let code = l?.serial_no || '';
      for (const c of l?.claims || []) {
        if (c.status === 'replaced' && c.replacement_serial_no) code = c.replacement_serial_no;
      }
      return code;
    },

    // YYYY-MM-DD the warranty on this line ends, or '' when it has none. A
    // replacement carries the original's — see warranty_claims in server.js.
    lineWarrantyUntil(l) {
      return addMonths(l?.date, l?.warranty_months);
    },

    lineInWarranty(l) {
      const until = this.lineWarrantyUntil(l);
      return Boolean(until) && until >= todayLocal();
    },

    invoiceClaimable(inv) {
      return (inv?.lines || []).some((l) => this.lineWithCustomer(l) > 0);
    },

    claimStatusLabel(c) {
      return { open: 'Open', replaced: 'Replaced', repaired: 'Repaired', rejected: 'Not covered' }[c?.status] || c?.status;
    },

    claimTone(c) {
      return { open: 'is-warning', replaced: 'is-success', repaired: 'is-violet', rejected: 'is-neutral' }[c?.status] || 'is-neutral';
    },

    // One line under the item on the receipt and in the history:
    // "Warranty 26-09-2026: A001 replaced with A002 (no charge)".
    claimText(c) {
      const when = `Warranty ${this.fmtDateDMY(c.date)}`;
      const what = c.faulty_serial_no || (Number(c.quantity) > 1 ? `${c.quantity} pcs` : '1 pc');
      if (c.status === 'replaced') {
        return c.replacement_serial_no
          ? `${when}: ${what} replaced with ${c.replacement_serial_no} (no charge)`
          : `${when}: ${what} replaced (no charge)`;
      }
      if (c.status === 'repaired') return `${when}: ${what} repaired and handed back`;
      if (c.status === 'rejected') return `${when}: ${what} not covered, handed back`;
      return `${when}: ${what} taken in`;
    },

    // For the Warranty section: the claims to list, open ones first.
    get visibleClaims() {
      const list = this.claimFilter === 'open' ? this.claims.filter((c) => c.status === 'open') : this.claims;
      return [...list].sort((a, b) => (b.status === 'open') - (a.status === 'open') || Number(b.id) - Number(a.id));
    },

    get openClaimCount() {
      return this.claims.filter((c) => c.status === 'open').length;
    },

    claimInvoice(c) {
      return this.invoices.find((i) => Number(i.id) === Number(c.invoice_id)) || null;
    },

    openClaim(inv, { saleId = null } = {}) {
      const lines = (inv?.lines || []).filter((l) => this.lineWithCustomer(l) > 0);
      if (!lines.length) {
        this.notify('Nothing on this invoice is with the customer any more.', 'error');
        return;
      }
      const chosen = lines.find((l) => Number(l.id) === Number(saleId)) || lines[0];
      this.claimDraft = {
        kind: 'new', invoice: inv, saleId: chosen.id, qty: 1, problem: '',
        replaceNow: true, code: '', note: '', error: '', saving: false,
      };
    },

    // The serial list's Warranty button: the unit's invoice, its line chosen.
    openClaimForSerial(row) {
      const inv = this.invoices.find((i) => Number(i.id) === Number(row.invoice_id));
      if (!inv) {
        this.notify(`Invoice #${row.invoice_id} is not loaded.`, 'error');
        return;
      }
      this.openClaim(inv, { saleId: row.sale_id });
    },

    openResolveClaim(claim) {
      this.claimDraft = {
        kind: 'resolve', claim, invoice: this.claimInvoice(claim), action: 'replace',
        code: '', note: '', error: '', saving: false,
      };
    },

    closeClaim() {
      this.claimDraft = null;
    },

    // The lines a new claim can be made on.
    get claimLines() {
      return (this.claimDraft?.invoice?.lines || []).filter((l) => this.lineWithCustomer(l) > 0);
    },

    // The invoice line the dialog is about.
    get claimLine() {
      const d = this.claimDraft;
      if (!d) return null;
      const id = d.kind === 'resolve' ? d.claim.sale_id : d.saleId;
      return (d.invoice?.lines || []).find((l) => Number(l.id) === Number(id)) || null;
    },

    get claimProduct() {
      const name = this.claimLine?.item_name;
      return name ? this.inventory.find((i) => i.item_name === name) || null : null;
    },

    // True when giving a replacement needs a serial scanned.
    get claimNeedsSerial() {
      return this.serialTracked(this.claimProduct);
    },

    // Whether the dialog, as filled in, hands something out from stock.
    get claimGivesReplacement() {
      const d = this.claimDraft;
      return Boolean(d) && (d.kind === 'new' ? d.replaceNow : d.action === 'replace');
    },

    async submitClaim() {
      const d = this.claimDraft;
      if (!d || d.saving) return;
      if (this.claimGivesReplacement && this.claimNeedsSerial && !String(d.code).trim()) {
        d.error = `Scan the serial of the ${this.claimLine?.item_name || 'unit'} being given.`;
        return;
      }
      d.saving = true;
      d.error = '';
      try {
        const res = d.kind === 'new'
          ? await fetch('/api/warranty-claims', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sale_id: d.saleId,
              quantity: Number(d.qty) || 1,
              problem: d.problem,
              replace_now: d.replaceNow,
              replacement_serial_no: d.replaceNow ? String(d.code).trim() : '',
            }),
          })
          : await fetch(`/api/warranty-claims/${d.claim.id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: d.action,
              note: d.note,
              replacement_serial_no: d.action === 'replace' ? String(d.code).trim() : '',
            }),
          });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not save the claim.'));
        const claim = await res.json();
        this.claimDraft = null;
        await this.loadData({ quiet: true });

        // A replacement leaves with the reprinted invoice, which now names it
        // under the original line — that is the customer's warranty slip.
        const fresh = this.invoices.find((inv) => Number(inv.id) === Number(claim.invoice_id));
        if (claim.status === 'replaced' && fresh) {
          this.notify(`Claim #${claim.id}: replacement given. Print the invoice for the customer.`);
          this.showReceipt(fresh);
        } else {
          this.notify(claim.status === 'open' ? `Claim #${claim.id} saved — the unit is in the shop.` : `Claim #${claim.id} settled.`);
          if (fresh && Number(this.currentReceipt?.id) === Number(fresh.id)) this.currentReceipt = fresh;
        }
      } catch (err) {
        d.error = err.message || 'Could not save the claim.';
      } finally {
        d.saving = false;
      }
    },

    /* -------------------------------------------------------- faulty stock

       Everything kept aside or away at the supplier, one row per serial and
       one per product-and-state for goods without serials. The moves out of
       it are POST /api/stock-movements; only a write-off costs money. */

    serialStatusLabel(status) {
      return {
        available: 'Available', sold: 'Sold', defective: 'Faulty', at_supplier: 'At supplier',
        written_off: 'Written off', exchanged: 'Exchanged',
      }[status] || status;
    },

    // The badge tone for a serial's status (see .nb-badge in input.css).
    serialBadgeClass(status) {
      return {
        available: 'is-success',
        sold: 'is-neutral',
        defective: 'is-danger',
        at_supplier: 'is-violet',
      }[status] || 'is-neutral';
    },

    // Units at the supplier: serials plus the count of goods without them.
    supplierCount(item) {
      return Number(item?.supplier_serials || 0) + Number(item?.supplier_quantity || 0);
    },

    get faultyQueue() {
      const state = { defective: 'defective', at_supplier: 'supplier' };
      const rows = this.faultyUnits.map((u) => ({
        key: `s${u.id}`, serialId: u.id, serial_no: u.serial_no, item_name: u.item_name || '(deleted product)',
        productId: u.product_id, state: state[u.status], qty: 1, since: u.since,
      }));
      for (const item of this.inventory) {
        if (Number(item.defective_quantity) > 0) {
          rows.push({ key: `d${item.id}`, productId: item.id, item_name: item.item_name, state: 'defective', qty: Number(item.defective_quantity) });
        }
        if (Number(item.supplier_quantity) > 0) {
          rows.push({ key: `p${item.id}`, productId: item.id, item_name: item.item_name, state: 'supplier', qty: Number(item.supplier_quantity) });
        }
      }
      // Faulty in the shop first — that is where a decision is waiting.
      return rows.sort((a, b) => (a.state === 'supplier') - (b.state === 'supplier') || a.item_name.localeCompare(b.item_name));
    },

    get faultyInShop() {
      return this.faultyQueue.filter((r) => r.state === 'defective');
    },

    get faultyAtSupplier() {
      return this.faultyQueue.filter((r) => r.state === 'supplier');
    },

    /* What is waiting on the shop, for the dashboard and the bell: each a
       real count from loaded data, and each a way to the page that deals
       with it. Nothing is listed when nothing is waiting. */
    get alerts() {
      const out = [];
      const low = this.lowStockItems.length;
      if (low) {
        out.push({ key: 'low', tone: 'text-red-600 bg-red-100', icon: 'warning',
          label: `${low} product${low === 1 ? '' : 's'} low on stock`, sub: `Fewer than ${LOW_STOCK_THRESHOLD} units left`,
          run: () => this.go('lowstock') });
      }
      const due = this.invoices.filter((inv) => this.isInvoiceDue(inv));
      if (due.length) {
        const amount = due.reduce((sum, inv) => sum + this.invoiceDue(inv), 0);
        out.push({ key: 'due', tone: 'text-amber-700 bg-amber-100', icon: 'banknotes',
          label: `${this.fmt(amount)} still due`, sub: `On ${due.length} invoice${due.length === 1 ? '' : 's'}`,
          run: () => { this.saleSearch = ''; this.saleStatus = 'due'; this.setDateRange('all'); this.go('sales'); } });
      }
      if (this.openClaimCount) {
        out.push({ key: 'claims', tone: 'text-blue-700 bg-blue-100', icon: 'shield',
          label: `${this.openClaimCount} open warranty claim${this.openClaimCount === 1 ? '' : 's'}`, sub: 'Taken in, waiting to be settled',
          run: () => { this.claimFilter = 'open'; this.go('warranty'); } });
      }
      if (this.faultyQueue.length) {
        out.push({ key: 'faulty', tone: 'text-violet-700 bg-violet-100', icon: 'wrench',
          label: `${this.faultyQueue.length} faulty item${this.faultyQueue.length === 1 ? '' : 's'} waiting`,
          sub: `${this.faultyInShop.length} in the shop · ${this.faultyAtSupplier.length} with a supplier`,
          run: () => this.go('faulty') });
      }
      return out;
    },

    // The queue row's buying price, for the write-off confirmation.
    queueCost(row) {
      return Number(this.inventory.find((i) => Number(i.id) === Number(row?.productId))?.cost_price || 0);
    },

    // Newest first, for the list of moves.
    get recentMoves() {
      return [...this.movements].reverse();
    },

    moveStateLabel(state) {
      return { stock: 'Stock', defective: 'Faulty', supplier: 'At supplier', written_off: 'Written off' }[state] || state;
    },

    // What a move is called on its button and in the dialog title.
    moveActionLabel(from, to) {
      return {
        'stock>defective': 'Mark faulty',
        'defective>supplier': 'Send to supplier',
        'defective>stock': 'Fixed — back to stock',
        'supplier>stock': 'Back from supplier',
        'supplier>defective': 'Back, still faulty',
        'defective>written_off': 'Write off',
        'supplier>written_off': 'Write off',
      }[`${from}>${to}`] || 'Move';
    },

    // Suppliers the shop has bought from, for the Send to supplier box.
    get supplierNames() {
      return [...new Set(this.purchases.map((p) => String(p.dealer_name || '').trim()).filter(Boolean))].sort();
    },

    openMove(row, to) {
      this.moveDraft = {
        row, to, qty: row ? row.qty : 1, party: '', note: '', newSerial: '', exchange: false,
        productId: '', error: '', saving: false,
      };
    },

    // Marking shelf stock faulty: a serial from the serial list, or a count of
    // goods without serials picked in the dialog.
    openMarkFaulty(serialRow = null) {
      const row = serialRow
        ? { key: `s${serialRow.id}`, serialId: serialRow.id, serial_no: serialRow.serial_no, item_name: serialRow.item_name,
          productId: serialRow.product_id, state: 'stock', qty: 1 }
        : null;
      this.openMove(row, 'defective');
      if (!row) this.moveDraft.qty = 1;
    },

    closeMove() {
      this.moveDraft = null;
    },

    // Products that can have shelf stock marked faulty by count.
    get markableProducts() {
      return this.inventory.filter((i) => !this.serialTracked(i) && Number(i.quantity) > 0);
    },

    // The state the dialog moves from.
    get moveFrom() {
      return this.moveDraft?.row ? this.moveDraft.row.state : 'stock';
    },

    // Most units this move can take: the row's count, or the product's stock.
    get moveMax() {
      const d = this.moveDraft;
      if (!d) return 0;
      if (d.row) return d.row.qty;
      return Number(this.inventory.find((i) => String(i.id) === String(d.productId))?.quantity || 0);
    },

    get moveLoss() {
      const d = this.moveDraft;
      if (!d || d.to !== 'written_off') return 0;
      return this.queueCost(d.row) * (Number(d.qty) || 0);
    },

    async submitMove() {
      const d = this.moveDraft;
      if (!d || d.saving) return;
      const serialId = d.row?.serialId;
      const productId = d.row ? d.row.productId : d.productId;
      const qty = Number(d.qty);
      if (!serialId) {
        if (!productId) {
          d.error = 'Choose the product.';
          return;
        }
        if (!Number.isInteger(qty) || qty < 1 || qty > this.moveMax) {
          d.error = `Enter a whole number from 1 to ${this.moveMax}.`;
          return;
        }
      }
      if (d.exchange && !String(d.newSerial).trim()) {
        d.error = 'Scan the serial of the unit the supplier gave.';
        return;
      }
      d.saving = true;
      d.error = '';
      try {
        const res = await fetch('/api/stock-movements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(serialId
            ? { serial_id: serialId, to_state: d.to, party: d.party, note: d.note, new_serial_no: d.exchange ? String(d.newSerial).trim() : '' }
            : { product_id: productId, from_state: this.moveFrom, to_state: d.to, quantity: qty, party: d.party, note: d.note }),
        });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not save the move.'));
        const label = this.moveActionLabel(this.moveFrom, d.to);
        this.moveDraft = null;
        this.notify(`${label}: done.`);
        await this.loadData({ quiet: true });
      } catch (err) {
        d.error = err.message || 'Could not save the move.';
      } finally {
        d.saving = false;
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
              : found.status === 'available'
                ? `${found.serial_no} is already in stock for ${found.item_name || 'another product'}.`
                : `${found.serial_no} is already registered to ${found.item_name || 'another product'}.`
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
      this.serialProductId = String(item.id);
      this.serialQuery = '';
      this.serialStatus = 'all';
      // Stale, so arriving on the page fetches the filtered list.
      this.serialLoaded = false;
      this.go('serials');
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
      const who = `invoice #${e.invoice_id}${e.customer_name ? `, ${e.customer_name}` : ''}`;
      const note = e.note ? ` — ${e.note}` : '';
      if (e.event === 'claimed') return `In under warranty from ${who}${note}`;
      if (e.event === 'replacement_out') return `Given as warranty replacement on ${who} (no charge)${note}`;
      if (e.event === 'repaired') return `Repaired, handed back on ${who}${note}`;
      if (e.event === 'claim_rejected') return `Not covered, handed back on ${who}${note}`;
      const plain = {
        marked_faulty: 'Marked faulty in the shop',
        sent_to_supplier: 'Sent to supplier',
        fixed_in_shop: 'Fixed in the shop — back in stock',
        back_from_supplier: 'Back from supplier — in stock',
        back_from_supplier_faulty: 'Back from supplier, still faulty',
        written_off: 'Written off',
        exchanged: 'Exchanged by the supplier',
      }[e.event];
      if (plain) return plain + note;
      return e.event;
    },

    // Remove: a mis-scan taken out. (Return has its own dialog — openReturn().)
    async confirmSerialAction() {
      const dlg = this.serialDialog;
      if (!dlg || dlg.saving) return;
      dlg.saving = true;
      dlg.error = '';
      try {
        const res = await fetch(`/api/serials/${dlg.row.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await this.describeFailure(res, 'Could not remove the serial.'));
        this.notify(`${dlg.row.serial_no} removed from stock.`);
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
