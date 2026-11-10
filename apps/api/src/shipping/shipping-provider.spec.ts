import { selectShippingProvider, type ShippingProvider } from './shipping-provider.js';

const adapter = (code: string) => ({ code }) as ShippingProvider;

describe('selectShippingProvider', () => {
  const manual = adapter('manual');

  it('defaults to the manual adapter', () => {
    expect(selectShippingProvider(undefined, [manual])).toBe(manual);
    expect(selectShippingProvider('  ', [manual])).toBe(manual);
  });

  it('picks the adapter named by SHIPPING_PROVIDER', () => {
    const other = adapter('carrier');
    expect(selectShippingProvider('carrier', [manual, other])).toBe(other);
  });

  it('fails with a clear message for an unknown provider', () => {
    expect(() => selectShippingProvider('dhl', [manual])).toThrow(
      'Unknown SHIPPING_PROVIDER "dhl". Expected one of: manual.',
    );
  });
});
