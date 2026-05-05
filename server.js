'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'fitness.db');
const DATABASE_URL = process.env.DATABASE_URL || '';

const DEFAULT_STATE = {
  balance: 0,
  workoutPrice: 80,
  reminderTime: '09:00',
  notificationsEnabled: false,
  totalWorkouts: 0,
  logs: []
};

const app = express();
let storage = null;

function sanitizeState(input) {
  const candidate = input && typeof input === 'object' ? input : {};
  const merged = { ...DEFAULT_STATE, ...candidate };

  return {
    balance: Number.isFinite(merged.balance) ? merged.balance : DEFAULT_STATE.balance,
    workoutPrice: Number.isFinite(merged.workoutPrice) && merged.workoutPrice > 0
      ? merged.workoutPrice
      : DEFAULT_STATE.workoutPrice,
    reminderTime: typeof merged.reminderTime === 'string' ? merged.reminderTime : DEFAULT_STATE.reminderTime,
    notificationsEnabled: Boolean(merged.notificationsEnabled),
    totalWorkouts: Number.isFinite(merged.totalWorkouts) && merged.totalWorkouts >= 0
      ? Math.floor(merged.totalWorkouts)
      : DEFAULT_STATE.totalWorkouts,
    logs: Array.isArray(merged.logs) ? merged.logs : []
  };
}

function createSQLiteStorage() {
  const db = new sqlite3.Database(DB_PATH);

  function run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  }

  function get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  return {
    mode: 'sqlite',
    async init() {
      await run(`
        CREATE TABLE IF NOT EXISTS app_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          data TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      const row = await get('SELECT id FROM app_state WHERE id = 1');
      if (!row) {
        await run(
          'INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, datetime(\'now\'))',
          [JSON.stringify(DEFAULT_STATE)]
        );
      }
    },
    async getStateRow() {
      const row = await get('SELECT data, updated_at FROM app_state WHERE id = 1');
      if (!row) return { data: DEFAULT_STATE, updatedAt: null };
      return { data: JSON.parse(row.data), updatedAt: row.updated_at };
    },
    async saveStateRow(state) {
      await run(
        'UPDATE app_state SET data = ?, updated_at = datetime(\'now\') WHERE id = 1',
        [JSON.stringify(state)]
      );
    }
  };
}

function createPostgresStorage() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  return {
    mode: 'postgres',
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id SMALLINT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(
        `INSERT INTO app_state (id, data) VALUES (1, $1)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(DEFAULT_STATE)]
      );
    },
    async getStateRow() {
      const result = await pool.query(
        'SELECT data, updated_at FROM app_state WHERE id = 1 LIMIT 1'
      );
      if (!result.rows.length) return { data: DEFAULT_STATE, updatedAt: null };
      const row = result.rows[0];
      return {
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
        updatedAt: row.updated_at
      };
    },
    async saveStateRow(state) {
      await pool.query(
        `UPDATE app_state
         SET data = $1, updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify(state)]
      );
    }
  };
}

async function initStorage() {
  storage = DATABASE_URL ? createPostgresStorage() : createSQLiteStorage();
  await storage.init();
}

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/state', async (_req, res) => {
  try {
    const row = await storage.getStateRow();
    res.json({ state: sanitizeState(row.data), updatedAt: row.updatedAt });
  } catch (err) {
    console.error('[Server] Failed reading state:', err);
    res.status(500).json({ error: 'Failed reading state' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const sanitized = sanitizeState(req.body && req.body.state ? req.body.state : req.body);
    await storage.saveStateRow(sanitized);
    res.json({ ok: true, state: sanitized });
  } catch (err) {
    console.error('[Server] Failed writing state:', err);
    res.status(500).json({ error: 'Failed writing state' });
  }
});

app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initStorage()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
      console.log(`[Server] Storage: ${storage.mode}`);
      if (storage.mode === 'sqlite') {
        console.log(`[Server] DB: ${DB_PATH}`);
      }
    });
  })
  .catch(err => {
    console.error('[Server] Failed to initialize DB:', err);
    process.exit(1);
  });
