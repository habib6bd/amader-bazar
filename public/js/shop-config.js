/* NetBazar — shop identity.

   Every place the shop's name, address or contacts appear (login screen,
   navbar, printed invoice) reads from here, so correcting a detail is a
   one-line edit in this file and needs no rebuild.

   Loaded before app.js; see index.html. */

const SHOP = {
  // Shown in the UI chrome (login card, navbar, tab title).
  name: 'NetBazar',

  // Shown on the printed invoice header — kept separate so the invoice can
  // use the uppercase wordmark without shouting in the dashboard.
  invoiceName: 'NET BAZAR',

  addressLine1: 'Hazi Rahim Super Market, 2nd Floor',
  addressLine2: 'Shafipur Bazar',

  // NOTE: verify the first number against the shop's own signboard — the
  // fourth digit of the handwritten note it was copied from is ambiguous.
  phones: ['01626-813708', '01817691565'],

  email: 'netbazar775@gmail.com',

  // Printed under the totals block. Blank entries are skipped.
  terms: [
    'Goods once sold are not returnable.',
    'Warranty claims are subject to the manufacturer’s terms.',
  ],
};

window.SHOP = SHOP;
