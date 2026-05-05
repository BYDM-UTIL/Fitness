'use strict';

const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'fitness.db');

const DEFAULT_STATE = {
  balance: 0,
  workoutPrice: 80,
  reminderTime: '09:00',
  notificationsEnabled: false,
  totalWorkouts: 0,
  logs: []
};

const app = express();
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

async function initDb() {
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
}

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/state', async (_req, res) => {
  try {
    const row = await get('SELECT data, updated_at FROM app_state WHERE id = 1');
    const parsed = row ? JSON.parse(row.data) : DEFAULT_STATE;
    res.json({ state: sanitizeState(parsed), updatedAt: row ? row.updated_at : null });
  } catch (err) {
    console.error('[Server] Failed reading state:', err);
    res.status(500).json({ error: 'Failed reading state' });
  }
});

app.put('/api/state', async (req, res) => {
  try {
    const sanitized = sanitizeState(req.body && req.body.state ? req.body.state : req.body);
    await run(
      'UPDATE app_state SET data = ?, updated_at = datetime(\'now\') WHERE id = 1',
      [JSON.stringify(sanitized)]
    );
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

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
      console.log(`[Server] DB: ${DB_PATH}`);
    });
  })
  .catch(err => {
    console.error('[Server] Failed to initialize DB:', err);
    process.exit(1);
  });
