# Hagalery LaKol — online store

Monorepo for the storefront (Angular SSR), the admin (Angular Material) and the API (NestJS + Prisma + PostgreSQL).

- Development guidelines, structure and commands: [../CLAUDE.md](../CLAUDE.md)
- Phased plan: [../DEV_PLAN.md](../DEV_PLAN.md)
- Brand and design tokens: [../BRAND.md](../BRAND.md)
- Product spec (Hebrew): [../../Lets start - md files/](../../Lets%20start%20-%20md%20files/README.md)

## Quick start

```bash
cp .env.example .env
npm install
npm run db:up
npm run dev
```

Storefront: http://localhost:4200 · Admin: http://localhost:4300 · API health: http://localhost:3000/api/health
