const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const db = require('./db');

// Web Push (VAPID) configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:myla@myla.fyi',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

function celsiusToFahrenheit(c) {
  if (c == null || c === '') return null;
  return +(parseFloat(c) * 9 / 5 + 32).toFixed(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Persistent storage paths
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Build version for cache-busting static assets (changes on each server start)
const BUILD_VERSION = Date.now().toString(36);
app.use((req, res, next) => {
  res.locals.buildVersion = BUILD_VERSION;
  next();
});

// Serve sw.js with no-store so browsers (especially Safari) always check for updates
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Static files - serve uploads from persistent disk, rest from public/
app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir }),
  secret: process.env.SESSION_SECRET || 'myla-fyi-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// File upload config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  }
});

// Auth middleware - admin
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/admin/login');
}

// Auth middleware - viewer (shared password to view the site)
function requireViewer(req, res, next) {
  if (req.session && (req.session.viewer || req.session.authenticated)) return next();
  res.redirect('/login');
}

// Make common data available to all views
app.use((req, res, next) => {
  res.locals.authenticated = req.session && req.session.authenticated;
  res.locals.viewer = req.session && (req.session.viewer || req.session.authenticated);
  res.locals.settings = db.getSettings();
  res.locals.vapidPublicKey = VAPID_PUBLIC_KEY;
  next();
});

// Helper: compute age info from settings
function getAgeInfo(settings) {
  const birthDate = new Date(settings.birth_date + 'T00:00:00');
  const dueDate = new Date(settings.due_date + 'T00:00:00');
  // Use local date string in the configured timezone so "today" matches the user's day
  const tz = settings.timezone || process.env.TZ || 'America/New_York';
  const localDateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
  const today = new Date(localDateStr + 'T00:00:00');

  const actualDays = Math.floor((today - birthDate) / (1000 * 60 * 60 * 24));
  const correctedDays = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
  const daysToDueDate = Math.max(0, Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24)));

  const gestWeeks = parseInt(settings.gestational_age_weeks) || 24;
  const gestDays = parseInt(settings.gestational_age_days) || 0;
  const correctedGestDays = (gestWeeks * 7 + gestDays) + actualDays;
  const correctedGestWeeks = Math.floor(correctedGestDays / 7);
  const correctedGestRemainder = correctedGestDays % 7;

  return {
    actualDays,
    actualWeeks: Math.floor(actualDays / 7),
    actualRemainder: actualDays % 7,
    correctedDays: Math.max(0, correctedDays),
    correctedWeeks: Math.floor(Math.max(0, correctedDays) / 7),
    correctedRemainder: Math.max(0, correctedDays) % 7,
    daysToDueDate,
    correctedGestWeeks,
    correctedGestRemainder,
    nicuDays: actualDays,
  };
}

// ============ VIEWER AUTH ============

app.get('/login', (req, res) => {
  if (req.session && (req.session.viewer || req.session.authenticated)) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  const viewerPassword = process.env.VIEWER_PASSWORD || 'myla2026';
  const adminPassword = process.env.ADMIN_PASSWORD || 'myla3926';
  if (password === adminPassword) {
    req.session.authenticated = true;
    req.session.viewer = true;
    return res.redirect('/');
  }
  if (password === viewerPassword) {
    req.session.viewer = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Incorrect password. Please try again.' });
});

// ============ PUBLIC ROUTES ============

app.get('/', requireViewer, (_req, res) => {
  const allUpdates = db.getUpdates();
  const updates = allUpdates.slice(0, 10);
  const pinned = db.getPinnedUpdate();
  const latestVitals = db.getLatestVitals();
  const vitals = db.getVitals(30);
  const milestones = db.getMilestonesByCategory();
  const settings = db.getSettings();
  const ageInfo = getAgeInfo(settings);
  const updateIds = updates.map(u => u.id);
  if (pinned && !updateIds.includes(pinned.id)) updateIds.push(pinned.id);
  const photosMap = db.getPhotosForUpdates(updateIds);
  res.render('index', { updates, allUpdates, pinned, latestVitals, vitals, milestones, ageInfo, photosMap });
});

app.get('/update/:id', requireViewer, (req, res) => {
  const update = db.getUpdate(req.params.id);
  if (!update) return res.status(404).render('404');
  const photos = db.getUpdatePhotos(update.id);
  const { prev, next } = db.getAdjacentUpdates(update.update_date, update.id);
  res.render('update', { update, photos, prev, next });
});

app.get('/journey', requireViewer, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 10;
  const allUpdates = db.getUpdates(); // newest first
  const total = allUpdates.length;
  const totalPages = Math.ceil(total / perPage);
  // Reverse to oldest-first for catch-up reading
  const chronological = allUpdates.slice().reverse();
  const pageUpdates = chronological.slice((page - 1) * perPage, page * perPage);
  const updateIds = pageUpdates.map(u => u.id);
  const photosMap = db.getPhotosForUpdates(updateIds);
  const settings = db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('updates', { updates: pageUpdates, photosMap, page, totalPages, ageInfo });
});

app.get('/milestones', requireViewer, (_req, res) => {
  const milestones = db.getMilestonesByCategory();
  const settings = db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('milestones', { milestones, ageInfo });
});

app.get('/vitals', requireViewer, (_req, res) => {
  const vitals = db.getVitals(90);
  const settings = db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('vitals', { vitals, ageInfo });
});

// JSON endpoint for chart data
app.get('/api/vitals', requireViewer, (_req, res) => {
  const vitals = db.getVitals(90);
  res.json(vitals.reverse());
});

// ============ ADMIN ROUTES ============

app.get('/admin/login', (_req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'myla3926';
  if (password === adminPassword) {
    req.session.authenticated = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Incorrect password. Please try again.' });
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Download database backup
app.get('/admin/backup/db', requireAuth, (_req, res) => {
  // Flush WAL to main DB file so the download contains all data
  db.checkpoint();
  const dbPath = path.join(dataDir, 'myla.db');
  res.download(dbPath, 'myla.db');
});

// Download uploads as zip
app.get('/admin/backup/uploads', requireAuth, (_req, res) => {
  const archiver = require('archiver');
  const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, 'uploads');
  res.attachment('uploads.zip');
  const archive = archiver('zip');
  archive.pipe(res);
  archive.directory(uploadsDir, false);
  archive.finalize();
});

app.get('/admin', requireAuth, (_req, res) => {
  const updates = db.getUpdates();
  const latestVitals = db.getLatestVitals();
  const settings = db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('admin/dashboard', { updates, latestVitals, ageInfo });
});

// Updates
app.get('/admin/new', requireAuth, (_req, res) => {
  res.render('admin/editor', { update: null, photos: [] });
});

app.post('/admin/new', requireAuth, upload.array('photos', 20), (req, res) => {
  const { title, content, sentiment, update_date } = req.body;
  const photo = req.files && req.files.length ? '/uploads/' + req.files[0].filename : null;
  const result = db.createUpdate({ title, content, sentiment: parseInt(sentiment) || 5, photo, update_date });
  if (req.files && req.files.length) {
    const photoPaths = req.files.map(f => '/uploads/' + f.filename);
    db.addUpdatePhotos(result.lastInsertRowid, photoPaths);
  }
  // Send push notification for the new update
  const snippet = content.substring(0, 100).replace(/\n/g, ' ') + (content.length > 100 ? '...' : '');
  sendPushNotifications(
    'New Update: ' + title,
    snippet,
    '/update/' + result.lastInsertRowid
  );
  res.redirect('/admin');
});

app.get('/admin/edit/:id', requireAuth, (req, res) => {
  const update = db.getUpdate(req.params.id);
  if (!update) return res.status(404).render('404');
  const photos = db.getUpdatePhotos(update.id);
  res.render('admin/editor', { update, photos });
});

app.post('/admin/edit/:id', requireAuth, upload.array('photos', 20), (req, res) => {
  const { title, content, sentiment, update_date } = req.body;
  const photo = req.files && req.files.length ? '/uploads/' + req.files[0].filename : null;
  db.editUpdate(req.params.id, { title, content, sentiment: parseInt(sentiment) || 5, photo, update_date });
  if (req.files && req.files.length) {
    const photoPaths = req.files.map(f => '/uploads/' + f.filename);
    db.addUpdatePhotos(req.params.id, photoPaths);
  }
  res.redirect('/admin');
});

app.post('/admin/photos/reorder', requireAuth, express.json(), (req, res) => {
  const { photoIds } = req.body;
  if (Array.isArray(photoIds)) {
    db.reorderUpdatePhotos(photoIds.map(Number));
  }
  res.json({ ok: true });
});

app.post('/admin/photo/delete/:id', requireAuth, (req, res) => {
  db.deleteUpdatePhoto(req.params.id);
  res.redirect('back');
});

app.post('/admin/delete/:id', requireAuth, (req, res) => {
  db.deleteUpdate(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/pin/:id', requireAuth, (req, res) => {
  db.pinUpdate(req.params.id);
  res.redirect('/admin');
});

app.post('/admin/unpin/:id', requireAuth, (req, res) => {
  db.unpinUpdate(req.params.id);
  res.redirect('/admin');
});

// Vitals
app.get('/admin/vitals', requireAuth, (_req, res) => {
  const vitals = db.getVitals(30);
  const latest = db.getLatestVitals();
  res.render('admin/vitals', { vitals, latest, editing: null });
});

app.post('/admin/vitals', requireAuth, (req, res) => {
  db.createVital({
    recorded_at: req.body.recorded_at || new Date().toISOString(),
    weight_grams: req.body.weight_grams,
    length_cm: req.body.length_cm,
    head_circumference_cm: req.body.head_circumference_cm,
    heart_rate: req.body.heart_rate,
    respiratory_rate: req.body.respiratory_rate,
    oxygen_saturation: req.body.oxygen_saturation,
    temperature: celsiusToFahrenheit(req.body.temperature),
    blood_pressure: req.body.blood_pressure,
    fio2: req.body.fio2,
    respiratory_support: req.body.respiratory_support,
    crib_type: req.body.crib_type,
    feeding_type: req.body.feeding_type,
    feeding_volume_ml: req.body.feeding_volume_ml,
    feeding_frequency_minutes: req.body.feeding_frequency_minutes,
    notes: req.body.notes,
  });
  res.redirect('/admin/vitals');
});

app.get('/admin/vitals/edit/:id', requireAuth, (req, res) => {
  const vital = db.getVital(req.params.id);
  if (!vital) return res.status(404).render('404');
  const vitals = db.getVitals(30);
  res.render('admin/vitals', { vitals, latest: vital, editing: vital });
});

app.post('/admin/vitals/edit/:id', requireAuth, (req, res) => {
  db.editVital(req.params.id, {
    recorded_at: req.body.recorded_at || new Date().toISOString(),
    weight_grams: req.body.weight_grams,
    length_cm: req.body.length_cm,
    head_circumference_cm: req.body.head_circumference_cm,
    heart_rate: req.body.heart_rate,
    respiratory_rate: req.body.respiratory_rate,
    oxygen_saturation: req.body.oxygen_saturation,
    temperature: celsiusToFahrenheit(req.body.temperature),
    blood_pressure: req.body.blood_pressure,
    fio2: req.body.fio2,
    respiratory_support: req.body.respiratory_support,
    crib_type: req.body.crib_type,
    feeding_type: req.body.feeding_type,
    feeding_volume_ml: req.body.feeding_volume_ml,
    feeding_frequency_minutes: req.body.feeding_frequency_minutes,
    notes: req.body.notes,
  });
  res.redirect('/admin/vitals');
});

app.post('/admin/vitals/delete/:id', requireAuth, (req, res) => {
  db.deleteVital(req.params.id);
  res.redirect('/admin/vitals');
});

// Milestones
app.get('/admin/milestones', requireAuth, (_req, res) => {
  const milestones = db.getMilestonesByCategory();
  res.render('admin/milestones', { milestones });
});

app.post('/admin/milestones/achieve/:id', requireAuth, (req, res) => {
  db.achieveMilestone(req.params.id, req.body.achieved_date);
  res.redirect('/admin/milestones');
});

app.post('/admin/milestones/unachieve/:id', requireAuth, (req, res) => {
  db.unachieveMilestone(req.params.id);
  res.redirect('/admin/milestones');
});

app.post('/admin/milestones/new', requireAuth, (req, res) => {
  const category = req.body.category;
  if (!category) return res.redirect('/admin/milestones');
  db.createMilestone({
    category,
    title: req.body.title,
    description: req.body.description,
    sort_order: req.body.sort_order,
  });
  res.redirect('/admin/milestones');
});

app.post('/admin/milestones/delete/:id', requireAuth, (req, res) => {
  db.deleteMilestone(req.params.id);
  res.redirect('/admin/milestones');
});

// Settings
app.get('/admin/settings', requireAuth, (_req, res) => {
  res.render('admin/settings');
});

app.post('/admin/settings', requireAuth, upload.single('site_logo'), (req, res) => {
  const fields = ['baby_name', 'birth_date', 'birth_time', 'gestational_age_weeks', 'gestational_age_days', 'due_date', 'birth_weight_grams', 'nicu_name', 'theme'];
  for (const field of fields) {
    if (req.body[field] !== undefined) db.setSetting(field, req.body[field]);
  }
  if (req.file) {
    db.setSetting('site_logo', '/uploads/' + req.file.filename);
  }
  res.redirect('/admin/settings');
});

// Reset logo to default
app.post('/admin/settings/reset-logo', requireAuth, (_req, res) => {
  db.setSetting('site_logo', '');
  res.redirect('/admin/settings');
});

// ============ PUSH NOTIFICATIONS ============

// Subscribe to push notifications
app.post('/api/push/subscribe', requireViewer, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  db.savePushSubscription(endpoint, keys.p256dh, keys.auth);
  res.json({ success: true });
});

// Unsubscribe from push notifications
app.post('/api/push/unsubscribe', requireViewer, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  db.deletePushSubscription(endpoint);
  res.json({ success: true });
});

// Send push notification to all subscribers (called internally)
function sendPushNotifications(title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = db.getAllPushSubscriptions();
  const payload = JSON.stringify({ title, body, url, tag: 'myla-update-' + Date.now() });

  for (const sub of subscriptions) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    };
    webpush.sendNotification(pushSub, payload).catch((err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Subscription expired or unsubscribed — clean up
        db.deletePushSubscription(sub.endpoint);
      }
    });
  }
}

// Dynamic manifest.json (uses settings for logo and theme color)
const THEME_COLORS = {
  rose: '#e44b6a', ocean: '#0ea5e9', lavender: '#a855f7', sunset: '#f97316', forest: '#10b981',
  'rose-light': '#e44b6a', 'ocean-light': '#0ea5e9', 'lavender-light': '#a855f7', 'sunset-light': '#f97316', 'forest-light': '#10b981',
};

app.get('/manifest.json', (_req, res) => {
  const settings = db.getSettings();
  const logo = settings.site_logo || '/images/white-footprint.png';
  const name = settings.baby_name || 'Baby';
  const theme = settings.theme || 'rose';
  const themeColor = THEME_COLORS[theme] || '#e44b6a';
  const isLight = theme.endsWith('-light');
  res.json({
    name: name + "'s Journey",
    short_name: name + ".fyi",
    description: "Follow " + name + "'s journey - born early, growing strong.",
    start_url: "/",
    display: "standalone",
    background_color: isLight ? '#f5f5f7' : '#0f1117',
    theme_color: themeColor,
    orientation: "portrait-primary",
    icons: [
      { src: logo, sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: logo, sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ]
  });
});

// 404
app.use((_req, res) => {
  res.status(404).render('404');
});

app.listen(PORT, () => {
  console.log(`Myla.fyi running on http://localhost:${PORT}`);
});
