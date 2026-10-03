import type { Translation } from "../src/domain/Translation.ts";

/** Sample translations for a seeded development database. See docs/mockdata.md. */
export const translations: Translation[] = [
    {
        lang: "fi",
        key: "invoice.title",
        value: "Lasku",
    },
    {
        lang: "fi",
        key: "invoice.total",
        value: "Yhteensä",
    },
    {
        lang: "fi",
        key: "invoice.dueDate",
        value: "Eräpäivä",
    },
    {
        lang: "sv",
        key: "invoice.title",
        value: "Faktura",
    },
    {
        lang: "sv",
        key: "invoice.total",
        value: "Totalt",
    },
    {
        lang: "sv",
        key: "invoice.dueDate",
        value: "Förfallodag",
    },
    {
        lang: "en",
        key: "invoice.title",
        value: "Invoice",
    },
    {
        lang: "en",
        key: "invoice.total",
        value: "Total",
    },
    {
        lang: "en",
        key: "invoice.dueDate",
        value: "Due date",
    },
    // A key shared with the other languages, not yet translated into this one.
    {
        lang: "en",
        key: "invoice.notes",
    },
];
