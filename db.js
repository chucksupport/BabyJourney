const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

// Turso in production, local SQLite file in dev
// Set TURSO_DATABASE_URL=libsql://your-db.turso.io for Turso
// Set TURSO_DATABASE_URL=file:./data/babyjourney.db for local dev (default)
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:./data/babyjourney.db';
const authToken = process.env.TURSO_AUTH_TOKEN || undefined;

// Ensure local data dir exists when using file: URL
if (dbUrl.startsWith('file:')) {
  const filePath = dbUrl.replace('file:', '');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const client = createClient({ url: dbUrl, authToken });

// Helper: get column names for a table (for migrations)
async function getColumns(table) {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.map(r => r.name);
}

// Initialize schema, run migrations, seed defaults
async function init() {
  // Create tables
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      mood TEXT DEFAULT 'good',
      sentiment INTEGER DEFAULT 5,
      photo TEXT,
      pinned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recorded_at DATETIME NOT NULL,
      weight_grams REAL,
      heart_rate INTEGER,
      respiratory_rate INTEGER,
      oxygen_saturation REAL,
      temperature REAL,
      fio2 REAL,
      respiratory_support TEXT,
      feeding_type TEXT,
      feeding_volume_ml REAL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      achieved INTEGER DEFAULT 0,
      achieved_at DATETIME,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS update_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      update_id INTEGER NOT NULL,
      photo TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (update_id) REFERENCES updates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migrations: add missing columns
  const updateCols = await getColumns('updates');
  if (!updateCols.includes('sentiment')) {
    await client.execute('ALTER TABLE updates ADD COLUMN sentiment INTEGER DEFAULT 5');
  }
  if (!updateCols.includes('update_date')) {
    await client.execute('ALTER TABLE updates ADD COLUMN update_date DATETIME');
    await client.execute('UPDATE updates SET update_date = created_at WHERE update_date IS NULL');
  }

  const vitalCols = await getColumns('vitals');
  if (!vitalCols.includes('length_cm')) {
    await client.execute('ALTER TABLE vitals ADD COLUMN length_cm REAL');
  }
  if (!vitalCols.includes('head_circumference_cm')) {
    await client.execute('ALTER TABLE vitals ADD COLUMN head_circumference_cm REAL');
  }
  if (!vitalCols.includes('crib_type')) {
    await client.execute('ALTER TABLE vitals ADD COLUMN crib_type TEXT');
  }
  if (!vitalCols.includes('feeding_frequency_minutes')) {
    await client.execute('ALTER TABLE vitals ADD COLUMN feeding_frequency_minutes INTEGER');
  }
  if (!vitalCols.includes('blood_pressure')) {
    await client.execute('ALTER TABLE vitals ADD COLUMN blood_pressure TEXT');
  }

  // Migrate single photo column data into update_photos table
  try {
    const countResult = await client.execute('SELECT COUNT(*) as count FROM update_photos');
    if (Number(countResult.rows[0].count) === 0) {
      const photosResult = await client.execute("SELECT id, photo FROM updates WHERE photo IS NOT NULL AND photo != ''");
      if (photosResult.rows.length > 0) {
        const stmts = photosResult.rows.map(u => ({
          sql: 'INSERT INTO update_photos (update_id, photo, sort_order) VALUES (?, ?, 0)',
          args: [u.id, u.photo]
        }));
        await client.batch(stmts);
      }
    }
  } catch (e) {
    console.error('Photo migration error:', e.message);
  }

  // Seed default milestones if empty
  const milestoneCount = Number((await client.execute('SELECT COUNT(*) as count FROM milestones')).rows[0].count);
  if (milestoneCount === 0) {
    const defaultMilestones = [
      ['breathing', 'Off high-frequency ventilator', 'Transitioned to conventional ventilator', 10],
      ['breathing', 'Off conventional ventilator', 'Transitioned to CPAP', 20],
      ['breathing', 'Off CPAP', 'Transitioned to nasal cannula', 30],
      ['breathing', 'Breathing room air', 'No respiratory support needed', 40],
      ['breathing', 'Apnea-free for 5+ days', 'No significant apnea or bradycardia episodes', 50],
      ['feeding', 'First breast milk drops', 'Started trophic feeds', 10],
      ['feeding', 'Tolerating full gavage feeds', 'Full volume through feeding tube', 20],
      ['feeding', 'First oral feeding attempt', 'Started practicing bottle or breast', 30],
      ['feeding', 'All feeds by mouth', 'No more feeding tube needed', 40],
      ['growth', 'Regained birth weight', 'Back to birth weight', 10],
      ['growth', 'Reached 1,000g', 'Over 2 pounds', 20],
      ['growth', 'Reached 1,500g', 'Over 3.3 pounds', 30],
      ['growth', 'Reached 1,800g', 'About 4 pounds - discharge range', 40],
      ['thermoregulation', 'Moved to open crib', 'No longer needs isolette', 10],
      ['thermoregulation', 'Maintaining own temperature', 'Stable body temp independently', 20],
      ['firsts', 'First kangaroo care', 'First skin-to-skin hold', 10],
      ['firsts', 'First bath', '', 20],
      ['firsts', 'First outfit', '', 30],
      ['firsts', 'Eyes open', '', 40],
      ['firsts', 'Passed hearing screening', '', 50],
      ['firsts', 'Passed car seat test', '', 60],
      ['firsts', 'Going home', 'Discharged from NICU', 70],
      ['iv_and_lines', 'UAC/UVC removed', 'Umbilical lines no longer needed', 10],
      ['iv_and_lines', 'PICC line placed', 'Peripherally inserted central catheter', 20],
      ['iv_and_lines', 'PICC line removed', 'No longer needs central line', 30],
      ['iv_and_lines', 'Last IV removed', 'No more IV access needed', 40],
    ];
    const stmts = defaultMilestones.map(m => ({
      sql: 'INSERT INTO milestones (category, title, description, sort_order) VALUES (?, ?, ?, ?)',
      args: m
    }));
    await client.batch(stmts);
  }

  // Seed default settings if empty
  const settingsCount = Number((await client.execute('SELECT COUNT(*) as count FROM settings')).rows[0].count);
  if (settingsCount === 0) {
    const defaults = [
      ['baby_name', 'Baby'],
      ['completed_initial_setup', '0'],
      ['birth_date', ''],
      ['birth_time', ''],
      ['gestational_age_weeks', ''],
      ['gestational_age_days', ''],
      ['due_date', ''],
      ['birth_weight_grams', ''],
      ['nicu_name', ''],
      ['storage_used_bytes', '0'],
    ];
    const stmts = defaults.map(([k, v]) => ({
      sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
      args: [k, v]
    }));
    await client.batch(stmts);
  }
}

// Settings cache to avoid hitting Turso on every request
let settingsCache = null;
let settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 30_000; // 30 seconds

module.exports = {
  init,

  checkpoint() {
    // No-op for Turso; WAL checkpoint not applicable
  },

  // Updates
  async getUpdates(limit) {
    if (limit) {
      const r = await client.execute({ sql: 'SELECT * FROM updates ORDER BY update_date DESC LIMIT ?', args: [limit] });
      return r.rows;
    }
    const r = await client.execute('SELECT * FROM updates ORDER BY update_date DESC');
    return r.rows;
  },

  async getUpdate(id) {
    const r = await client.execute({ sql: 'SELECT * FROM updates WHERE id = ?', args: [id] });
    return r.rows[0] || null;
  },

  async getAdjacentUpdates(updateDate, id) {
    const prevR = await client.execute({
      sql: 'SELECT id, title FROM updates WHERE update_date < ? OR (update_date = ? AND id < ?) ORDER BY update_date DESC, id DESC LIMIT 1',
      args: [updateDate, updateDate, id]
    });
    const nextR = await client.execute({
      sql: 'SELECT id, title FROM updates WHERE update_date > ? OR (update_date = ? AND id > ?) ORDER BY update_date ASC, id ASC LIMIT 1',
      args: [updateDate, updateDate, id]
    });
    return { prev: prevR.rows[0] || null, next: nextR.rows[0] || null };
  },

  async getPinnedUpdate() {
    const r = await client.execute('SELECT * FROM updates WHERE pinned = 1 ORDER BY updated_at DESC LIMIT 1');
    return r.rows[0] || null;
  },

  async createUpdate({ title, content, sentiment, photo, update_date }) {
    const s = sentiment || 5;
    const mood = s <= 3 ? 'tough' : s >= 8 ? 'great' : 'good';
    const r = await client.execute({
      sql: 'INSERT INTO updates (title, content, mood, sentiment, photo, update_date) VALUES (?, ?, ?, ?, ?, ?)',
      args: [title, content, mood, s, photo, update_date || new Date().toISOString()]
    });
    return { lastInsertRowid: Number(r.lastInsertRowid) };
  },

  async editUpdate(id, { title, content, sentiment, photo, update_date }) {
    const s = sentiment || 5;
    const mood = s <= 3 ? 'tough' : s >= 8 ? 'great' : 'good';
    if (photo) {
      return client.execute({
        sql: 'UPDATE updates SET title = ?, content = ?, mood = ?, sentiment = ?, photo = ?, update_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        args: [title, content, mood, s, photo, update_date, id]
      });
    }
    return client.execute({
      sql: 'UPDATE updates SET title = ?, content = ?, mood = ?, sentiment = ?, update_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      args: [title, content, mood, s, update_date, id]
    });
  },

  async deleteUpdate(id) {
    await client.execute({ sql: 'DELETE FROM update_photos WHERE update_id = ?', args: [id] });
    return client.execute({ sql: 'DELETE FROM updates WHERE id = ?', args: [id] });
  },

  // Update Photos
  async getUpdatePhotos(updateId) {
    const r = await client.execute({ sql: 'SELECT * FROM update_photos WHERE update_id = ? ORDER BY sort_order ASC, id ASC', args: [updateId] });
    return r.rows;
  },

  async getPhotosForUpdates(updateIds) {
    if (!updateIds.length) return {};
    const placeholders = updateIds.map(() => '?').join(',');
    const r = await client.execute({ sql: `SELECT * FROM update_photos WHERE update_id IN (${placeholders}) ORDER BY sort_order ASC, id ASC`, args: updateIds });
    const grouped = {};
    for (const row of r.rows) {
      if (!grouped[row.update_id]) grouped[row.update_id] = [];
      grouped[row.update_id].push(row);
    }
    return grouped;
  },

  async addUpdatePhotos(updateId, photoPaths) {
    const maxR = await client.execute({ sql: 'SELECT COALESCE(MAX(sort_order), -1) as max_order FROM update_photos WHERE update_id = ?', args: [updateId] });
    const maxOrder = Number(maxR.rows[0].max_order);
    const stmts = photoPaths.map((p, i) => ({
      sql: 'INSERT INTO update_photos (update_id, photo, sort_order) VALUES (?, ?, ?)',
      args: [updateId, p, maxOrder + 1 + i]
    }));
    await client.batch(stmts);
  },

  async reorderUpdatePhotos(photoIds) {
    const stmts = photoIds.map((id, i) => ({
      sql: 'UPDATE update_photos SET sort_order = ? WHERE id = ?',
      args: [i, id]
    }));
    await client.batch(stmts);
  },

  async deleteUpdatePhoto(photoId) {
    return client.execute({ sql: 'DELETE FROM update_photos WHERE id = ?', args: [photoId] });
  },

  async pinUpdate(id) {
    await client.execute('UPDATE updates SET pinned = 0');
    await client.execute({ sql: 'UPDATE updates SET pinned = 1 WHERE id = ?', args: [id] });
  },

  async unpinUpdate(id) {
    return client.execute({ sql: 'UPDATE updates SET pinned = 0 WHERE id = ?', args: [id] });
  },

  // Vitals
  async getVitals(limit = 90) {
    const r = await client.execute({ sql: 'SELECT * FROM vitals ORDER BY recorded_at DESC LIMIT ?', args: [limit] });
    return r.rows;
  },

  async getVitalsRange(start, end) {
    const r = await client.execute({ sql: 'SELECT * FROM vitals WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at ASC', args: [start, end] });
    return r.rows;
  },

  async getLatestVitals() {
    const r = await client.execute('SELECT * FROM vitals ORDER BY recorded_at DESC LIMIT 1');
    return r.rows[0] || null;
  },

  async createVital(data) {
    return client.execute({
      sql: `INSERT INTO vitals (recorded_at, weight_grams, length_cm, head_circumference_cm, heart_rate, respiratory_rate, oxygen_saturation, temperature, blood_pressure, fio2, respiratory_support, crib_type, feeding_type, feeding_volume_ml, feeding_frequency_minutes, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.recorded_at, data.weight_grams || null, data.length_cm || null,
        data.head_circumference_cm || null, data.heart_rate || null,
        data.respiratory_rate || null,
        data.oxygen_saturation || null, data.temperature || null,
        data.blood_pressure || null, data.fio2 || null,
        data.respiratory_support || null, data.crib_type || null,
        data.feeding_type || null, data.feeding_volume_ml || null,
        data.feeding_frequency_minutes || null,
        data.notes || null
      ]
    });
  },

  async getVital(id) {
    const r = await client.execute({ sql: 'SELECT * FROM vitals WHERE id = ?', args: [id] });
    return r.rows[0] || null;
  },

  async editVital(id, data) {
    return client.execute({
      sql: `UPDATE vitals SET recorded_at = ?, weight_grams = ?, length_cm = ?, head_circumference_cm = ?,
              heart_rate = ?, respiratory_rate = ?, oxygen_saturation = ?, temperature = ?,
              blood_pressure = ?, fio2 = ?, respiratory_support = ?, crib_type = ?,
              feeding_type = ?, feeding_volume_ml = ?, feeding_frequency_minutes = ?, notes = ?
            WHERE id = ?`,
      args: [
        data.recorded_at, data.weight_grams || null, data.length_cm || null,
        data.head_circumference_cm || null, data.heart_rate || null,
        data.respiratory_rate || null,
        data.oxygen_saturation || null, data.temperature || null,
        data.blood_pressure || null, data.fio2 || null,
        data.respiratory_support || null, data.crib_type || null,
        data.feeding_type || null, data.feeding_volume_ml || null,
        data.feeding_frequency_minutes || null,
        data.notes || null, id
      ]
    });
  },

  async deleteVital(id) {
    return client.execute({ sql: 'DELETE FROM vitals WHERE id = ?', args: [id] });
  },

  // Milestones
  async getMilestones() {
    const r = await client.execute('SELECT * FROM milestones ORDER BY category, sort_order ASC');
    return r.rows;
  },

  async getMilestonesByCategory() {
    const r = await client.execute('SELECT * FROM milestones ORDER BY category, sort_order ASC');
    const grouped = {};
    for (const row of r.rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    return grouped;
  },

  async achieveMilestone(id, date) {
    const achieved_at = date ? new Date(date + 'T00:00:00').toISOString() : new Date().toISOString();
    return client.execute({ sql: 'UPDATE milestones SET achieved = 1, achieved_at = ? WHERE id = ?', args: [achieved_at, id] });
  },

  async unachieveMilestone(id) {
    return client.execute({ sql: 'UPDATE milestones SET achieved = 0, achieved_at = NULL WHERE id = ?', args: [id] });
  },

  async createMilestone({ category, title, description, sort_order }) {
    return client.execute({
      sql: 'INSERT INTO milestones (category, title, description, sort_order) VALUES (?, ?, ?, ?)',
      args: [category, title, description || '', sort_order || 99]
    });
  },

  async deleteMilestone(id) {
    return client.execute({ sql: 'DELETE FROM milestones WHERE id = ?', args: [id] });
  },

  // Settings (with cache for performance over network)
  async getSettings() {
    const now = Date.now();
    if (settingsCache && (now - settingsCacheTime) < SETTINGS_CACHE_TTL) {
      return settingsCache;
    }
    const r = await client.execute('SELECT * FROM settings');
    const obj = {};
    for (const row of r.rows) obj[row.key] = row.value;
    settingsCache = obj;
    settingsCacheTime = now;
    return obj;
  },

  async setSetting(key, value) {
    settingsCache = null; // invalidate cache
    return client.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: [key, value] });
  },

  // Storage tracking
  async getStorageUsed() {
    const r = await client.execute({ sql: "SELECT value FROM settings WHERE key = 'storage_used_bytes'", args: [] });
    return Number(r.rows[0]?.value || 0);
  },

  async addStorageUsed(bytes) {
    const current = await this.getStorageUsed();
    return this.setSetting('storage_used_bytes', String(current + bytes));
  },

  async subtractStorageUsed(bytes) {
    const current = await this.getStorageUsed();
    return this.setSetting('storage_used_bytes', String(Math.max(0, current - bytes)));
  },

  // Push Subscriptions
  async savePushSubscription(endpoint, p256dh, auth) {
    return client.execute({
      sql: 'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?)',
      args: [endpoint, p256dh, auth]
    });
  },

  async getAllPushSubscriptions() {
    const r = await client.execute('SELECT * FROM push_subscriptions');
    return r.rows;
  },

  async deletePushSubscription(endpoint) {
    return client.execute({ sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [endpoint] });
  },

  // Backup: export all data as JSON
  async exportAllData() {
    const [updates, vitals, milestones, settings, photos, subscriptions] = await Promise.all([
      client.execute('SELECT * FROM updates ORDER BY id'),
      client.execute('SELECT * FROM vitals ORDER BY id'),
      client.execute('SELECT * FROM milestones ORDER BY id'),
      client.execute('SELECT * FROM settings'),
      client.execute('SELECT * FROM update_photos ORDER BY id'),
      client.execute('SELECT * FROM push_subscriptions ORDER BY id'),
    ]);
    return {
      updates: updates.rows,
      vitals: vitals.rows,
      milestones: milestones.rows,
      settings: settings.rows,
      update_photos: photos.rows,
      push_subscriptions: subscriptions.rows,
      exportedAt: new Date().toISOString(),
    };
  },
};
