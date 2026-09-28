# Invoice sending

`sendInvoice` in `packages/spec/src/operations/InvoiceOperations.ts` issues a draft and
delivers it. This note records the delivery options it takes, the party data
sending depends on, and what is deferred.

## Options are call choices; routing is master data

The split matters, because Finvoice does not send an invoice without a
*verkkolaskuosoite* — and that is not a per-call parameter.

- **Party routing identity is stable master data.** The recipient's e-invoice
  address (`Customer.eInvoiceAddress`) and its operator (`Customer.eInvoiceOperator`)
  identify where an invoice goes and who carries it; the issuer's own pair lives
  on `Seller`. They change when a company changes operator, not per invoice.
- **`sendInvoice` opts are transient choices.** Which format, which channel,
  which language, what to say in the cover note.

Putting the address on the operation instead would make every caller re-supply
data the `Customer` already owns and store it nowhere — the duplication
`docs/invoice-snapshotting.md` avoids by linking the `Customer` rather than
copying it into the call.

## `sendInvoice` options

- **`format`** — the e-invoice serialization. `InvoiceFormat` is an open union
  (`finvoice`, `peppolBis`, `ubl`, plus any other string). `finvoice` is the
  Finnish national format, `peppolBis` the PEPPOL BIS Billing 3.0 profile used
  across SEPA, and `ubl` the OASIS format. Omitting it defers to the party's
  default.
- **`delivery`** — the channel. `InvoiceDelivery` is an open union (`eInvoice`,
  `email`, `print`, `download`, plus any other string). `eInvoice` routes it over
  the operator network, which is what needs the routing identities below.
- **`eInvoiceAddress` / `eInvoiceOperator`** — an override for the recipient's
  routing, for a customer not yet in master data. The stored `Customer` values
  are the normal source.
- **`language`** — the rendering language, an override of the party defaults
  below. `Language` is an open union (`fi`, `sv`, `en`, plus any other string).
- **`message`** — a cover note. **`replyTo`** — where replies go.
- **`attachPdf`** — also attach a human-readable PDF alongside the structured
  document.

Every option is optional; `sendInvoice({ invoice })` is the common case.

## Where the language lives

Language is stored in four places, mirroring how routing is layered:

- **`Customer.language` / `Seller.language`** — each party's default rendering
  language. Master data, like the routing pair.
- **`Invoice.language`** — the language chosen for this draft.
- **`sendInvoice` `language`** — a per-send override of the draft and the party
  defaults.
- **`InvoiceSent.language`** — frozen at send time, and **required**, like
  `number`: the send resolves it (an explicit override, else the draft, else a
  party default) and the snapshot records what was actually rendered. Two
  renders of one snapshot in different languages are different documents, so it
  belongs on the legal record rather than being recomputed.

## Why the unions are open

Formats, channels, and languages all accrete country by country, and a closed
union would force a spec change for every new member. The known members keep
autocomplete and narrowing while the `(string & {})` branch accepts the rest —
the same trade recorded for `Unit` and `Currency`, including the `string & {}`
vs `string` collapse. See `docs/primitives.md`.

## Routing identity, concretely

A Finnish `verkkolaskuosoite` is the operator scheme prefix followed by the
business id, so business id `1234567-8` becomes `003712345678`. It is therefore
often *derivable* from `Customer.businessId`, yet stored as its own
`EInvoiceAddress` because the address may be a custom, non-derived one. The
operator (välittäjätunnus, e.g. `maventa`, `apix`) is what the network routes
on. `EInvoiceOperator` is an open union for the same reason as the others.

`Seller` mirrors `Customer`'s identity fields plus the same routing pair, so both
parties of an invoice can be routed. `Invoice.seller` is a `@relation` and
`InvoiceSent.seller` an `@inlined` copy, exactly as the customer is — an issued
invoice is a legal document and must freeze who issued it, not re-render it from
a live company record.

## Gotchas

- **Address scheme is not modelled.** PEPPOL distinguishes OVT (`0037`) from GLN
  (`0088`) by a scheme id that the current model leaves implicit in the address.
- **The routing override is not persisted.** An override on `sendInvoice` is not
  written back to `Customer`, so the next send needs it again. The same holds for
  the `language` override.
- **The inlined parties leak their language.** `@inlined` on the customer and
  seller fields flatten every scalar field, so `customerLanguage` and
  `sellerLanguage` land on `invoice_sent` next to its own `language` column. See
  `docs/invoice-snapshotting.md`.
- **The delivery records nothing.** Neither `Invoice` nor `InvoiceSent` carries a
  format or channel, so the chosen delivery is invisible afterwards. The language
  is the exception: it is on both.
- **`InvoiceOperations` is an interface with no implementation.** Nothing in
  `packages/backend/` implements it yet, so these options are a contract, not
  behaviour.

## Deliberately not implemented

- **Access points / intermediate routing.** Only the operator is named; the
  sender's and receiver's access-point ids on a PEPPOL exchange are not.
- **Per-customer delivery preference.** Whether a customer wants e-invoice,
  email, or paper is unmodelled, so `delivery` is per-call.
- **Delivery status and acknowledgements.** No sent / delivered / failed state.
- **Recording the delivery on `InvoiceSent`.** The snapshot freezes the parties'
  routing identities, not the channel the invoice travelled over.
- **A singleton-tenant view of `Seller`.** It is modelled as a mutable table like
  `Customer`; whether an installation has one seller or many is unaddressed.
