const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Use persistent disk path on Render, fallback to local ./data for dev
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'myla.db'));
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
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

// Migrate: add sentiment column if missing
try {
  db.prepare('SELECT sentiment FROM updates LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE updates ADD COLUMN sentiment INTEGER DEFAULT 5');
}

// Migrate: add update_date column if missing
try {
  db.prepare('SELECT update_date FROM updates LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE updates ADD COLUMN update_date DATETIME');
  db.exec('UPDATE updates SET update_date = created_at WHERE update_date IS NULL');
}

// Migrate: add length_cm, head_circumference_cm, crib_type to vitals
try {
  db.prepare('SELECT length_cm FROM vitals LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE vitals ADD COLUMN length_cm REAL');
}
try {
  db.prepare('SELECT head_circumference_cm FROM vitals LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE vitals ADD COLUMN head_circumference_cm REAL');
}
try {
  db.prepare('SELECT crib_type FROM vitals LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE vitals ADD COLUMN crib_type TEXT');
}

// Migrate: add feeding_frequency_minutes to vitals
try {
  db.prepare('SELECT feeding_frequency_minutes FROM vitals LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE vitals ADD COLUMN feeding_frequency_minutes INTEGER');
}

// Migrate: add blood_pressure to vitals
try {
  db.prepare('SELECT blood_pressure FROM vitals LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE vitals ADD COLUMN blood_pressure TEXT');
}

// Migrate: move existing single photo column data into update_photos table
try {
  const photosTableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='update_photos'").get();
  if (photosTableExists) {
    const migratedCheck = db.prepare("SELECT COUNT(*) as count FROM update_photos").get();
    if (migratedCheck.count === 0) {
      const updatesWithPhotos = db.prepare("SELECT id, photo FROM updates WHERE photo IS NOT NULL AND photo != ''").all();
      if (updatesWithPhotos.length > 0) {
        const insertPhoto = db.prepare('INSERT INTO update_photos (update_id, photo, sort_order) VALUES (?, ?, 0)');
        const tx = db.transaction(() => {
          for (const u of updatesWithPhotos) insertPhoto.run(u.id, u.photo);
        });
        tx();
      }
    }
  }
} catch (e) {
  console.error('Photo migration error:', e.message);
}

// Seed default milestones if empty
const milestoneCount = db.prepare('SELECT COUNT(*) as count FROM milestones').get().count;
if (milestoneCount === 0) {
  const defaultMilestones = [
    // Breathing
    ['breathing', 'Off high-frequency ventilator', 'Transitioned to conventional ventilator', 10],
    ['breathing', 'Off conventional ventilator', 'Transitioned to CPAP', 20],
    ['breathing', 'Off CPAP', 'Transitioned to nasal cannula', 30],
    ['breathing', 'Breathing room air', 'No respiratory support needed', 40],
    ['breathing', 'Apnea-free for 5+ days', 'No significant apnea or bradycardia episodes', 50],
    // Feeding
    ['feeding', 'First breast milk drops', 'Started trophic feeds', 10],
    ['feeding', 'Tolerating full gavage feeds', 'Full volume through feeding tube', 20],
    ['feeding', 'First oral feeding attempt', 'Started practicing bottle or breast', 30],
    ['feeding', 'All feeds by mouth', 'No more feeding tube needed', 40],
    // Growth
    ['growth', 'Regained birth weight', 'Back to birth weight', 10],
    ['growth', 'Reached 1,000g', 'Over 2 pounds', 20],
    ['growth', 'Reached 1,500g', 'Over 3.3 pounds', 30],
    ['growth', 'Reached 1,800g', 'About 4 pounds - discharge range', 40],
    // Thermoregulation
    ['thermoregulation', 'Moved to open crib', 'No longer needs isolette', 10],
    ['thermoregulation', 'Maintaining own temperature', 'Stable body temp independently', 20],
    // Big moments
    ['firsts', 'First kangaroo care', 'First skin-to-skin hold', 10],
    ['firsts', 'First bath', '', 20],
    ['firsts', 'First outfit', '', 30],
    ['firsts', 'Eyes open', '', 40],
    ['firsts', 'Passed hearing screening', '', 50],
    ['firsts', 'Passed car seat test', '', 60],
    ['firsts', 'Going home', 'Discharged from NICU', 70],
    // IV & Lines
    ['iv_and_lines', 'UAC/UVC removed', 'Umbilical lines no longer needed', 10],
    ['iv_and_lines', 'PICC line placed', 'Peripherally inserted central catheter', 20],
    ['iv_and_lines', 'PICC line removed', 'No longer needs central line', 30],
    ['iv_and_lines', 'Last IV removed', 'No more IV access needed', 40],
  ];

  const insert = db.prepare('INSERT INTO milestones (category, title, description, sort_order) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const m of defaultMilestones) insert.run(...m);
  });
  tx();
}

// Seed default settings if empty
const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get().count;
if (settingsCount === 0) {
  const defaults = [
    ['baby_name', 'Myla'],
    ['birth_date', '2026-03-09'],
    ['birth_time', '22:44'],
    ['gestational_age_weeks', '24'],
    ['gestational_age_days', '0'],
    ['due_date', '2026-06-22'],
    ['birth_weight_grams', ''],
    ['nicu_name', 'Cleveland Clinic'],
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of defaults) insert.run(k, v);
  });
  tx();
}

module.exports = {
  checkpoint() {
    db.pragma('wal_checkpoint(TRUNCATE)');
  },
  // Updates
  getUpdates(limit) {
    if (limit) return db.prepare('SELECT * FROM updates ORDER BY update_date DESC LIMIT ?').all(limit);
    return db.prepare('SELECT * FROM updates ORDER BY update_date DESC').all();
  },

  getUpdate(id) {
    return db.prepare('SELECT * FROM updates WHERE id = ?').get(id);
  },

  getAdjacentUpdates(updateDate, id) {
    const prev = db.prepare(
      'SELECT id, title FROM updates WHERE update_date < ? OR (update_date = ? AND id < ?) ORDER BY update_date DESC, id DESC LIMIT 1'
    ).get(updateDate, updateDate, id);
    const next = db.prepare(
      'SELECT id, title FROM updates WHERE update_date > ? OR (update_date = ? AND id > ?) ORDER BY update_date ASC, id ASC LIMIT 1'
    ).get(updateDate, updateDate, id);
    return { prev, next };
  },

  getPinnedUpdate() {
    return db.prepare('SELECT * FROM updates WHERE pinned = 1 ORDER BY updated_at DESC LIMIT 1').get();
  },

  createUpdate({ title, content, sentiment, photo, update_date }) {
    const s = sentiment || 5;
    const mood = s <= 3 ? 'tough' : s >= 8 ? 'great' : 'good';
    return db.prepare(
      'INSERT INTO updates (title, content, mood, sentiment, photo, update_date) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(title, content, mood, s, photo, update_date || new Date().toISOString());
  },

  editUpdate(id, { title, content, sentiment, photo, update_date }) {
    const s = sentiment || 5;
    const mood = s <= 3 ? 'tough' : s >= 8 ? 'great' : 'good';
    if (photo) {
      return db.prepare(
        'UPDATE updates SET title = ?, content = ?, mood = ?, sentiment = ?, photo = ?, update_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(title, content, mood, s, photo, update_date, id);
    }
    return db.prepare(
      'UPDATE updates SET title = ?, content = ?, mood = ?, sentiment = ?, update_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(title, content, mood, s, update_date, id);
  },

  deleteUpdate(id) {
    db.prepare('DELETE FROM update_photos WHERE update_id = ?').run(id);
    return db.prepare('DELETE FROM updates WHERE id = ?').run(id);
  },

  // Update Photos
  getUpdatePhotos(updateId) {
    return db.prepare('SELECT * FROM update_photos WHERE update_id = ? ORDER BY sort_order ASC, id ASC').all(updateId);
  },

  getPhotosForUpdates(updateIds) {
    if (!updateIds.length) return {};
    const placeholders = updateIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM update_photos WHERE update_id IN (${placeholders}) ORDER BY sort_order ASC, id ASC`).all(...updateIds);
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.update_id]) grouped[row.update_id] = [];
      grouped[row.update_id].push(row);
    }
    return grouped;
  },

  addUpdatePhotos(updateId, photoPaths) {
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) as max_order FROM update_photos WHERE update_id = ?').get(updateId).max_order;
    const insert = db.prepare('INSERT INTO update_photos (update_id, photo, sort_order) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      photoPaths.forEach((p, i) => insert.run(updateId, p, maxOrder + 1 + i));
    });
    tx();
  },

  reorderUpdatePhotos(photoIds) {
    const stmt = db.prepare('UPDATE update_photos SET sort_order = ? WHERE id = ?');
    const tx = db.transaction(() => {
      photoIds.forEach((id, i) => stmt.run(i, id));
    });
    tx();
  },

  deleteUpdatePhoto(photoId) {
    return db.prepare('DELETE FROM update_photos WHERE id = ?').run(photoId);
  },

  pinUpdate(id) {
    db.prepare('UPDATE updates SET pinned = 0').run();
    db.prepare('UPDATE updates SET pinned = 1 WHERE id = ?').run(id);
  },

  unpinUpdate(id) {
    db.prepare('UPDATE updates SET pinned = 0 WHERE id = ?').run(id);
  },

  // Vitals
  getVitals(limit = 90) {
    return db.prepare('SELECT * FROM vitals ORDER BY recorded_at DESC LIMIT ?').all(limit);
  },

  getVitalsRange(start, end) {
    return db.prepare('SELECT * FROM vitals WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at ASC').all(start, end);
  },

  getLatestVitals() {
    return db.prepare('SELECT * FROM vitals ORDER BY recorded_at DESC LIMIT 1').get();
  },

  createVital(data) {
    return db.prepare(`
      INSERT INTO vitals (recorded_at, weight_grams, length_cm, head_circumference_cm, heart_rate, respiratory_rate, oxygen_saturation, temperature, blood_pressure, fio2, respiratory_support, crib_type, feeding_type, feeding_volume_ml, feeding_frequency_minutes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.recorded_at, data.weight_grams || null, data.length_cm || null,
      data.head_circumference_cm || null, data.heart_rate || null,
      data.respiratory_rate || null,
      data.oxygen_saturation || null, data.temperature || null,
      data.blood_pressure || null, data.fio2 || null,
      data.respiratory_support || null, data.crib_type || null,
      data.feeding_type || null, data.feeding_volume_ml || null,
      data.feeding_frequency_minutes || null,
      data.notes || null
    );
  },

  getVital(id) {
    return db.prepare('SELECT * FROM vitals WHERE id = ?').get(id);
  },

  editVital(id, data) {
    return db.prepare(`
      UPDATE vitals SET recorded_at = ?, weight_grams = ?, length_cm = ?, head_circumference_cm = ?,
        heart_rate = ?, respiratory_rate = ?, oxygen_saturation = ?, temperature = ?,
        blood_pressure = ?, fio2 = ?, respiratory_support = ?, crib_type = ?,
        feeding_type = ?, feeding_volume_ml = ?, feeding_frequency_minutes = ?, notes = ?
      WHERE id = ?
    `).run(
      data.recorded_at, data.weight_grams || null, data.length_cm || null,
      data.head_circumference_cm || null, data.heart_rate || null,
      data.respiratory_rate || null,
      data.oxygen_saturation || null, data.temperature || null,
      data.blood_pressure || null, data.fio2 || null,
      data.respiratory_support || null, data.crib_type || null,
      data.feeding_type || null, data.feeding_volume_ml || null,
      data.feeding_frequency_minutes || null,
      data.notes || null, id
    );
  },

  deleteVital(id) {
    return db.prepare('DELETE FROM vitals WHERE id = ?').run(id);
  },

  // Milestones
  getMilestones() {
    return db.prepare('SELECT * FROM milestones ORDER BY category, sort_order ASC').all();
  },

  getMilestonesByCategory() {
    const rows = db.prepare('SELECT * FROM milestones ORDER BY category, sort_order ASC').all();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row);
    }
    return grouped;
  },

  achieveMilestone(id, date) {
    const achieved_at = date ? new Date(date + 'T00:00:00').toISOString() : new Date().toISOString();
    return db.prepare('UPDATE milestones SET achieved = 1, achieved_at = ? WHERE id = ?').run(achieved_at, id);
  },

  unachieveMilestone(id) {
    return db.prepare('UPDATE milestones SET achieved = 0, achieved_at = NULL WHERE id = ?').run(id);
  },

  createMilestone({ category, title, description, sort_order }) {
    return db.prepare('INSERT INTO milestones (category, title, description, sort_order) VALUES (?, ?, ?, ?)').run(category, title, description || '', sort_order || 99);
  },

  deleteMilestone(id) {
    return db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
  },

  // Settings
  getSettings() {
    const rows = db.prepare('SELECT * FROM settings').all();
    const obj = {};
    for (const row of rows) obj[row.key] = row.value;
    return obj;
  },

  setSetting(key, value) {
    return db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  },

  // Push Subscriptions
  savePushSubscription(endpoint, p256dh, auth) {
    return db.prepare(
      'INSERT OR REPLACE INTO push_subscriptions (endpoint, keys_p256dh, keys_auth) VALUES (?, ?, ?)'
    ).run(endpoint, p256dh, auth);
  },

  getAllPushSubscriptions() {
    return db.prepare('SELECT * FROM push_subscriptions').all();
  },

  deletePushSubscription(endpoint) {
    return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },
};
