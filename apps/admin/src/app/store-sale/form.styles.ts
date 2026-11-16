/** Field, list and notice styles shared by the store sale steps (tokens only; touch-size controls for the tablet). */
export const FORM_STYLES = `
  :host { display: grid; gap: var(--space-4); align-content: start; }
  h2 { margin: 0; font-size: var(--font-h3); }
  h2:focus { outline: none; }
  label { display: grid; gap: var(--space-1); }
  input:not([type='checkbox']), select {
    min-block-size: var(--control-height);
    padding-inline: var(--space-3);
    font: inherit;
    color: var(--color-text);
    background: var(--color-surface);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .row { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: end; }
  .row > label { flex: 1 1 12rem; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
  .error { margin: 0; color: var(--color-danger); }
  .muted { margin: 0; color: var(--color-text-secondary); font-size: var(--font-small); }
  .check { display: flex; gap: var(--space-2); align-items: center; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .card {
    display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    background: var(--color-surface);
    border: var(--border-width) solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .pick {
    min-block-size: var(--control-height); padding-inline: var(--space-4); font: inherit; text-align: start;
    color: var(--color-text); background: var(--color-surface);
    border: var(--border-width) solid var(--color-border); border-radius: var(--radius-md); cursor: pointer;
  }
  .pick[aria-pressed='true'], .pick[aria-checked='true'] {
    color: var(--color-on-accent); background: var(--color-accent); border-color: var(--color-accent);
  }
  .notice { margin: 0; padding: var(--space-2) var(--space-3); background: var(--color-warning-soft); border-radius: var(--radius-md); }
`;
