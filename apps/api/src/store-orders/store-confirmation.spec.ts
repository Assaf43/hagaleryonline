import { isConfirmationLive, STORE_CONFIRMATION_TTL_MS } from './store-confirmation.js';

describe('isConfirmationLive (spec §4.2)', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('is live within two hours of the confirmation and of the last use', () => {
    expect(isConfirmationLive({ storeConfirmedAt: ago(0), updatedAt: ago(0) }, now)).toBe(true);
    expect(
      isConfirmationLive(
        { storeConfirmedAt: ago(STORE_CONFIRMATION_TTL_MS), updatedAt: ago(STORE_CONFIRMATION_TTL_MS) },
        now,
      ),
    ).toBe(true);
  });

  it('lapses two hours after the confirmation, after two idle hours, or without one', () => {
    expect(isConfirmationLive({ storeConfirmedAt: ago(STORE_CONFIRMATION_TTL_MS + 1), updatedAt: ago(0) }, now)).toBe(
      false,
    );
    expect(isConfirmationLive({ storeConfirmedAt: ago(0), updatedAt: ago(STORE_CONFIRMATION_TTL_MS + 1) }, now)).toBe(
      false,
    );
    expect(isConfirmationLive({ storeConfirmedAt: null, updatedAt: ago(0) }, now)).toBe(false);
  });
});
