/**
 * A translation entry for an invoice.
 * 
 * @table translation
 */
export interface Translation {

    /**
     * The language code for the translation.
     * 
     * @fieldName Language code (e.g., "en", "fr")
     * @primaryKey
     * @widget text
     */
    languageCode: string;

    /**
     * The key identifying the translation entry.
     * 
     * @fieldName Key
     * @primaryKey
     * @widget text
     */
    key: string;

    /**
     * The translated value for the given key and language.
     * 
     * @fieldName Translation
     * @widget text
     */
    value?: string;

}