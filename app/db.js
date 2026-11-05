import mysql from 'mysql2/promise';

// A pool reconnects on its own: after MariaDB restarts, the next query opens a
// fresh connection, so the app recovers without a restart (roadmap Phase 0).
export function createPool(dbConfig) {
  return mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.name,
    charset: 'utf8mb4_unicode_ci',
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 5000,
    enableKeepAlive: true,
  });
}
