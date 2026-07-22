import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

const dbUrl = process.env.NEON_DATABASE_URL;
if (!dbUrl) {
  throw new Error(
    "NEON_DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Neon free tier: batasi koneksi agar tidak menghabiskan compute quota.
// Pooler Neon (pgBouncer) sudah menangani multiplexing, jadi pool kecil cukup.
export const pool = new Pool({
  connectionString: dbUrl,
  max: 5,                    // maksimum 5 koneksi aktif sekaligus
  idleTimeoutMillis: 10_000, // lepas koneksi idle setelah 10 detik
  connectionTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export * from "./schema";
