/** Display formatting shared by the storefront and the API's Hebrew messages. */

const ILS = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

/** 459000 agorot → "4,590": the number of `formatPrice` without the currency sign. */
export function formatPriceNumber(agorot: number): string {
  return ILS.format(Math.round(agorot / 100));
}

/** 459000 agorot → "4,590 ₪" (whole shekels; prices are VAT included). */
export function formatPrice(agorot: number): string {
  return `${formatPriceNumber(agorot)} ₪`;
}
