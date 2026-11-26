import { main } from './main.js';

describe('backup main', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it('--help prints the usage (0); no command prints it too (2)', async () => {
    expect(await main(['--help'], {})).toBe(0);
    expect(out.join('')).toContain('restore-db --object <key> --identity <file> --target-db <name> [--keep]');
    expect(await main([], {})).toBe(2);
  });

  it('an unknown command or option is a usage error (2)', async () => {
    expect(await main(['nope'], {})).toBe(2);
    expect(await main(['db', '--password', 'x'], {})).toBe(2);
    expect(out.join('')).not.toContain('--password x');
  });

  it('restore-db without its options is a usage error', async () => {
    expect(await main(['restore-db', '--identity', '/k'], {})).toBe(2);
    expect(out.join('')).toContain('Missing options for restore-db');
  });

  it('a missing setting fails with exit 1 and one scrubbed JSON line, before anything connects', async () => {
    expect(await main(['db'], {})).toBe(1);
    const line = JSON.parse(out.join('').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'error', context: 'Backup', detail: 'BACKUP_DATABASE_URL is required' });
  });
});
