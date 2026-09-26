# Returns, Warranty Claims & Faulty Stock

How NetBazar handles a product coming back — good, faulty, under warranty, or
sent on to a supplier — without ever touching a receipt that has already been
handed over. See [README.md](README.md) for the rest of the app.

---

## Contents

- [The one rule behind it](#the-one-rule-behind-it)
- [Where a unit can be](#where-a-unit-can-be)
- [Returns](#returns)
- [Warranty claims](#warranty-claims)
- [Faulty stock and the supplier](#faulty-stock-and-the-supplier)
- [Full example](#full-example-one-routers-life)
- [Database](#database)
- [API reference](#api-reference)

---

## The one rule behind it

**A money receipt is never edited after it is issued.** A return, a warranty
claim or a write-off is saved as a new dated record that links back to the
original invoice. The invoice's own lines stay exactly as printed; the return
or claim is added *below* them, on the receipt and in the sales figures alike.
Reprinting an old invoice always shows what was actually sold and what has
happened to it since.

## Where a unit can be

```
                 ┌──────────── Return (Good) ◄────────────┐
                 ▼                                         │
  [In Stock] ──Sale──► [With Customer] ──Return (Faulty)──► [Faulty] ──Send to supplier──► [At Supplier]
      ▲  │                  │     ▲                          │  ▲  │                          │  │  │
      │  └─Mark faulty──────┼─────┼─────────────────────────►┘  │  └──Write off──► [Written off]  │  │
      │                     │     │                              └──────Back, still faulty───────┘  │
      │                     │     └── Warranty replacement (from stock, ৳0)                          │
      │                     └── Warranty claim (faulty unit comes in) ──► [Faulty]                   │
      ├────────── Fixed — to stock (from Faulty) ◄──────────────────────                              │
      └────────── Back — to stock (from At Supplier) ◄───────────────────────────────────────────────┘
```

| Place | Counted in stock? | Sellable? | Shown as |
|---|---|---|---|
| In Stock | ✅ | ✅ | Serial badge **Available** |
| With Customer | — | — | **Sold**, or **Warranty replacement** |
| Faulty | ❌ | ❌ | **Faulty** — "n faulty" on the product row |
| At Supplier | ❌ | ❌ | **At supplier** — "n at supplier" on the product row |
| Written off | ❌ | ❌ | **Written off** — the only place that counts as a loss |
| Exchanged | ❌ | ❌ | The supplier swapped this unit for a new one |

The till refuses to sell any serial that is not **In Stock** and says where it
actually is.

Goods with no serial (cables, etc.) track the same states as plain counts on
the product: `quantity` (in stock), `defective_quantity` (faulty),
`supplier_quantity` (at supplier).

---

## Returns

**Where the button is:** Customer Sales History row (**Return**), the receipt
(**Return items**), or a sold serial in the Serials list (**Return**).

**The dialog:**
1. Tick a one-unit line, enter a quantity on a multi-unit line, or scan a
   serial to tick it.
2. Mark each returned line **Good — back to stock** or **Faulty — not for
   sale** (→ Faulty pile, see below).
3. Optional reason.
4. Check **Returned / New total / Refund / Still due**, then **Record
   return**.

**The refund is worked out, never typed.** The customer gets back only what
they paid *beyond the invoice's new total* — if money is still due, the
return reduces the due first:

| Invoice | Paid | Return 8 of 10 | New total | Refund | Due after |
|---|---|---|---|---|---|
| ৳10,000 | ৳10,000 | | ৳2,000 | **৳8,000** | ৳0 |
| ৳10,000 | ৳1,000 | | ৳2,000 | **৳0** | ৳1,000 |

**What changes:**
- The invoice's original lines are untouched; the return is shown under them,
  with the old total struck through and the new total, refund and due below
  it.
- **A return counts on the day it happens, not the day of the sale** — a past
  day's figures never change after the fact. Today's Sales, the date bar's
  **Returns**/**Refunded** figures, and profit all reflect this.
- A day can show negative net sales if returns outweigh that day's sales —
  that is correct, not a bug.

**Limits:** you can't return more than was sold on a line, and a unit
currently out on an *open* warranty claim can't be returned until the claim
is settled.

## Warranty claims

**Where the button is:** Customer Sales History row (**Warranty**), the
receipt (**Warranty claim**), or a sold serial in the Serials list
(**Warranty**).

**Making a claim:**
1. Pick the item (only asked when the invoice has several).
2. The dialog shows the serial the customer has *now* — the original, or an
   earlier replacement — and the warranty end date (red once past it; an
   expired claim can still be honoured, it's the shop's call).
3. Enter the problem, then either:
   - **Give a replacement now, from stock** — scan the replacement's serial
     (goods with no serial just take a quantity) → **Give replacement**.
   - **Take it in — decide later** → **Take it in**.

**What happens:**
- The faulty unit moves to **Faulty**, kept aside and not for sale.
- A replacement is taken **from stock**, linked to the **same original
  invoice line**, and inherits the **rest of the original warranty** (it
  still expires on the first sale's date, not a fresh 12 months).
- **No money moves and no new sale is written** — revenue and profit are
  unaffected.
- The receipt reopens automatically, now showing e.g. "Warranty
  26-09-2026: A001 replaced with A002 (no charge)" under the line — print it
  as the customer's slip.
- Searching Sales History by a *replacement's* serial still finds the
  original invoice.

**Settling an open claim:** the **🛠️ Warranty Claims** section lists open
claims (toggle to **All** for settled ones). **Settle** offers:
**Give a replacement from stock**, **Repaired — hand the same unit back**, or
**Not covered — hand it back as it is**.

A unit can be claimed again later (a replacement that also fails): the app
takes in whatever the customer currently holds and gives the next
replacement, and history and the receipt both show the whole chain.

## Faulty stock and the supplier

**🧰 Faulty & Supplier** lists everything **Faulty** or **At supplier** — from
returns, claims, or marked faulty by hand.

| Row state | Buttons | Result |
|---|---|---|
| Faulty | Send to supplier | → At supplier (asks for the supplier name) |
| | Fixed — to stock | → In Stock, sellable again |
| | Write off | → **Written off** (a loss) |
| At supplier | Back — to stock | → In Stock |
| | Back, still faulty | → Faulty |
| | Write off | → **Written off** (a loss) |

**Exchange:** if the supplier sends back a *different* unit, use **Back — to
stock**, tick "The supplier gave a different unit" and scan the new serial.
The new unit enters stock; the old serial becomes **Exchanged** — not a loss,
since the shop is made whole.

**Marking good stock faulty** (damage in the shop, not from a
return/claim): the section's **Mark stock faulty** button for goods with no
serial (pick product + quantity), or **Faulty** on an available unit in the
Serials list.

**Write-offs are the only loss.** Valued at the product's buying price, taken
off profit **on the day of the write-off**, shown before you confirm, and
irreversible. It appears in the date bar's **Write-offs** figure and in **Net
Profit** (= sales profit − returned profit − expenses − write-offs).
**History** in the section lists every move, its date, party and note.

## Full example: one router's life

1. Sell **A001** to a customer → invoice #12.
2. It comes back dead under warranty. **Warranty** on #12 → give
   **A002** now. A001 → Faulty; A002 is with the customer at ৳0; print #12 as
   their slip.
3. **Faulty & Supplier** → **Send to supplier** on A001.
4. The supplier sends back **B001** instead → **Back — to stock**, exchange,
   scan B001. B001 is in stock; A001 is Exchanged, no loss.
5. The customer later returns A002 (changed their mind). **Return** on #12,
   tick A002 **Good** → back in stock, refund worked out from what they paid
   beyond the new total.

Every step of this is visible on A001's own **History** in the Serials list.

---

## Database

Three tables added on top of the schema in [README.md](README.md#database),
migrated automatically on boot (`SCHEMA_VERSION` in `server.js`):

- **`returns`** / **`return_lines`** — one `returns` row per return made
  against an invoice (`refund_amount` computed, never typed), with one
  `return_lines` row per line returned (`quantity`, its share of the price as
  `amount`, the sale's own snapshotted `cost_price`, and `condition`:
  `good`/`faulty`).
- **`warranty_claims`** — one row per claim: `sale_id` (the original invoice
  line), `faulty_serial_id`/`faulty_serial_no` (the unit taken in),
  `warranty_until` (copied from the sale's date + warranty at claim time),
  `status` (`open`/`replaced`/`repaired`/`rejected`), and
  `replacement_serial_id`/`replacement_serial_no` once one is given.
- **`stock_movements`** — one row per faulty-stock move: `from_state`/
  `to_state` (`stock`/`defective`/`supplier`/`written_off`), `quantity`,
  `cost_price` (snapshotted — this is what a write-off's loss is valued at),
  and `party` (the supplier, when relevant).

`inventory` gains `defective_quantity` and `supplier_quantity` (the faulty and
at-supplier counts for goods with no serial). `product_serials.status` gains
`defective`, `at_supplier`, `written_off` and `exchanged` alongside the
existing `available`/`sold`; `product_serials.claim_id` marks a unit out as a
warranty replacement. `product_serials`/`sales` never lose rows — every
state change is a new `serial_events` row, so a unit's full life reads back
in order from `GET /api/serials/:id/history`.

## API reference

Same conventions as the [main API reference](README.md#api-reference) — JSON
bodies, no auth required yet.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/invoices/:id/returns` | `{lines: [{sale_id, quantity, condition}], reason?}` | `{id, refund_amount}`; `409` if a line has less left than requested, or is held by an open claim |
| `POST` | `/api/serials/:id/return` | `{note?}` | Back-compat wrapper: one serial, `condition: 'good'`, through the same path above |
| `POST` | `/api/warranty-claims` | `{sale_id, quantity?, problem?, replace_now?, replacement_serial_no?}` | the claim row; `409` if nothing on the line is with the customer, or the replacement serial isn't an available unit of the same product |
| `POST` | `/api/warranty-claims/:id/resolve` | `{action: 'replace'\|'repaired'\|'rejected', replacement_serial_no?, note?}` | the claim row; `409` if already settled |
| `POST` | `/api/stock-movements` | Serial: `{serial_id, to_state, party?, note?, new_serial_no?}` · By count: `{product_id, from_state, to_state, quantity, party?, note?}` | the movement row; `409` if the unit/quantity isn't where the move expects, `400` for a disallowed move (e.g. a serial-tracked product moved by count) |
| `GET` | `/api/data` | — | now also returns `returns`, `return_lines`, `warranty_claims`, `stock_movements`, `faulty_units` |

`GET /api/data`'s `inventory` rows also carry `defective_serials` and
`supplier_serials` (counts derived from `product_serials`, alongside the
plain `defective_quantity`/`supplier_quantity` columns for goods with no
serial).
