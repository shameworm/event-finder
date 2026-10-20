/**
 * drizzle-kit configuration.
 *
 *   npm run db:push      # create/update tables in whichever database is configured
 *   npm run db:generate   # write SQL migrations into ./drizzle/migrations
 *
 * With DATABASE_URL set you get the Postgres schema; without it, the SQLite file
 * under ~/.hermes/data/events-finder/events.db. SQLite tables are also created
 * automatically on first run, so db:push is only required for Postgres.
 */
import { defineConfig } from 'drizzle-kit';
import { DB_FILE } from './src/paths.ts';

const url = process.env['DATABASE_URL'];

export default url
  ? defineConfig({
      dialect: 'postgresql',
      schema: './drizzle/schema.pg.ts',
      out: './drizzle/migrations',
      dbCredentials: { url },
    })
  : defineConfig({
      dialect: 'sqlite',
      schema: './drizzle/schema.sqlite.ts',
      out: './drizzle/migrations',
      dbCredentials: { url: DB_FILE },
    });
