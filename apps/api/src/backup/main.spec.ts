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

  it('in production every command checks the environment first (exit 1, variable names only)', async () => {
    const env = {
      NODE_ENV: 'production',
      BACKUP_DATABASE_URL: 'postgresql://u:SENTINEL-pw@db.example.test:5432/nesto',
      BACKUP_AGE_RECIPIENT: `age1${'q'.repeat(58)}`,
      BACKUP_S3_ENDPOINT: 'https://backups.example.test',
      S3_ENDPOINT: 'https://s3.example.test',
    };
    for (const argv of [['db'], ['media'], ['daemon'], ['restore-media', '--identity', '/k']]) {
      out = [];
      expect(await main(argv, env), argv[0]).toBe(1);
      const line = JSON.parse(out.join('').trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ level: 'error', message: `${argv[0]} failed` });
      expect(String(line.detail)).toContain('BACKUP_DATABASE_URL: a remote database needs sslmode');
      expect(out.join('')).not.toContain('SENTINEL');
    }
    expect(await main(['--help'], env)).toBe(0);
    expect(await main(['nope'], env)).toBe(2);
  });
});
