const express = require('express');
const cookieSession = require('cookie-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');
const db = require('./db');

// Cloudinary setup (optional — falls back to local disk when not configured)
const useCloudinary = !!process.env.CLOUDINARY_CLOUD_NAME;
let cloudinary;
if (useCloudinary) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const cloudinaryFolder = process.env.CLOUDINARY_FOLDER || 'babyjourney';

function uploadToCloudinary(fileBuffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: cloudinaryFolder, resource_type: 'image' },
      (err, result) => err ? reject(err) : resolve({ url: result.secure_url, bytes: result.bytes })
    );
    stream.end(fileBuffer);
  });
}

// Web Push (VAPID) configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:hello@example.com',
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

// Local uploads dir (used only when Cloudinary is not configured)
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public/uploads');
if (!useCloudinary && !fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

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

// Static files
if (!useCloudinary) {
  app.use('/uploads', express.static(uploadsDir, { maxAge: '7d' }));
}
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Sessions — stateless cookie-session (no server-side store needed)
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'babyjourney-secret-change-me'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
}));

// File upload config — memory storage when using Cloudinary, disk otherwise
const storage = useCloudinary
  ? multer.memoryStorage()
  : multer.diskStorage({
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

// Storage limit (default 1GB, configurable via env)
const STORAGE_LIMIT_BYTES = (parseInt(process.env.STORAGE_LIMIT_MB) || 1024) * 1024 * 1024;

// Helper: handle file upload (Cloudinary or local disk) with storage tracking
async function handleUpload(file) {
  if (useCloudinary) {
    const result = await uploadToCloudinary(file.buffer);
    await db.addStorageUsed(result.bytes);
    return result.url;
  }
  // Local disk: track actual file size
  await db.addStorageUsed(file.size);
  return '/uploads/' + file.filename;
}

// Helper: check if storage limit would be exceeded
async function checkStorageLimit(files) {
  const used = await db.getStorageUsed();
  const incoming = files.reduce((sum, f) => sum + f.size, 0);
  if (used + incoming > STORAGE_LIMIT_BYTES) {
    const usedMB = (used / 1024 / 1024).toFixed(1);
    const limitMB = (STORAGE_LIMIT_BYTES / 1024 / 1024).toFixed(0);
    return `Storage limit reached (${usedMB} MB / ${limitMB} MB). Delete some photos to free up space.`;
  }
  return null;
}

// Async route wrapper for Express 4 (catches rejected promises)
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
app.use(asyncHandler(async (req, res, next) => {
  res.locals.authenticated = req.session && req.session.authenticated;
  res.locals.viewer = req.session && (req.session.viewer || req.session.authenticated);
  res.locals.settings = await db.getSettings();
  res.locals.vapidPublicKey = VAPID_PUBLIC_KEY;
  next();
}));

// Helper: compute age info from settings
function getAgeInfo(settings) {
  const birthDate = new Date(settings.birth_date + 'T00:00:00');
  const dueDate = new Date(settings.due_date + 'T00:00:00');
  const tz = settings.timezone || process.env.TZ || 'America/New_York';
  const localDateStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
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
  const viewerPassword = process.env.VIEWER_PASSWORD || 'viewer';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
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

app.get('/', requireViewer, asyncHandler(async (_req, res) => {
  const allUpdates = await db.getUpdates();
  const updates = allUpdates.slice(0, 10);
  const pinned = await db.getPinnedUpdate();
  const latestVitals = await db.getLatestVitals();
  const vitals = await db.getVitals(30);
  const milestones = await db.getMilestonesByCategory();
  const settings = await db.getSettings();
  const ageInfo = getAgeInfo(settings);
  const updateIds = updates.map(u => u.id);
  if (pinned && !updateIds.includes(pinned.id)) updateIds.push(pinned.id);
  const photosMap = await db.getPhotosForUpdates(updateIds);
  res.render('index', { updates, allUpdates, pinned, latestVitals, vitals, milestones, ageInfo, photosMap });
}));

app.get('/update/:id', requireViewer, asyncHandler(async (req, res) => {
  const update = await db.getUpdate(req.params.id);
  if (!update) return res.status(404).render('404');
  const photos = await db.getUpdatePhotos(update.id);
  const { prev, next } = await db.getAdjacentUpdates(update.update_date, update.id);
  res.render('update', { update, photos, prev, next });
}));

app.get('/journey', requireViewer, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = 10;
  const allUpdates = await db.getUpdates();
  const total = allUpdates.length;
  const totalPages = Math.ceil(total / perPage);
  const chronological = allUpdates.slice().reverse();
  const pageUpdates = chronological.slice((page - 1) * perPage, page * perPage);
  const updateIds = pageUpdates.map(u => u.id);
  const photosMap = await db.getPhotosForUpdates(updateIds);
  const settings = await db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('updates', { updates: pageUpdates, photosMap, page, totalPages, ageInfo });
}));

app.get('/milestones', requireViewer, asyncHandler(async (_req, res) => {
  const milestones = await db.getMilestonesByCategory();
  const settings = await db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('milestones', { milestones, ageInfo });
}));

app.get('/vitals', requireViewer, asyncHandler(async (_req, res) => {
  const vitals = await db.getVitals(90);
  const settings = await db.getSettings();
  const ageInfo = getAgeInfo(settings);
  res.render('vitals', { vitals, ageInfo });
}));

app.get('/api/vitals', requireViewer, asyncHandler(async (_req, res) => {
  const vitals = await db.getVitals(90);
  res.json(vitals.reverse());
}));

// ============ ADMIN ROUTES ============

app.get('/admin/login', (_req, res) => {
  res.render('admin/login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  if (password === adminPassword) {
    req.session.authenticated = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Incorrect password. Please try again.' });
});

app.get('/admin/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Download database backup as JSON
app.get('/admin/backup/db', requireAuth, asyncHandler(async (_req, res) => {
  const data = await db.exportAllData();
  res.setHeader('Content-Disposition', 'attachment; filename=babyjourney-backup.json');
  res.json(data);
}));

// Download photo URLs list (photos are stored in Cloudinary or listed for reference)
app.get('/admin/backup/uploads', requireAuth, asyncHandler(async (_req, res) => {
  if (!useCloudinary) {
    // Local mode: zip uploads directory
    const archiver = require('archiver');
    const localUploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public/uploads');
    res.attachment('uploads.zip');
    const archive = archiver('zip');
    archive.pipe(res);
    archive.directory(localUploadsDir, false);
    archive.finalize();
  } else {
    // Cloudinary mode: export photo URLs as JSON
    const photos = await db.exportAllData();
    const urls = photos.update_photos.map(p => p.photo);
    res.setHeader('Content-Disposition', 'attachment; filename=photo-urls.json');
    res.json({ photos: urls, exportedAt: new Date().toISOString() });
  }
}));

app.get('/admin', requireAuth, asyncHandler(async (_req, res) => {
  const updates = await db.getUpdates();
  const latestVitals = await db.getLatestVitals();
  const settings = await db.getSettings();
  const ageInfo = getAgeInfo(settings);
  const storageUsed = await db.getStorageUsed();
  const storageMB = (storageUsed / 1024 / 1024).toFixed(1);
  const storageLimitMB = (STORAGE_LIMIT_BYTES / 1024 / 1024).toFixed(0);
  const storagePercent = Math.min(100, ((storageUsed / STORAGE_LIMIT_BYTES) * 100)).toFixed(1);
  res.render('admin/dashboard', { updates, latestVitals, ageInfo, storageUsed, storageMB, storageLimitMB, storagePercent });
}));

// Updates
app.get('/admin/new', requireAuth, (_req, res) => {
  res.render('admin/editor', { update: null, photos: [] });
});

app.post('/admin/new', requireAuth, upload.array('photos', 20), asyncHandler(async (req, res) => {
  const { title, content, sentiment, update_date } = req.body;
  if (req.files && req.files.length) {
    const limitErr = await checkStorageLimit(req.files);
    if (limitErr) return res.status(400).render('admin/editor', { update: null, photos: [], error: limitErr });
  }
  let photo = null;
  if (req.files && req.files.length) {
    photo = await handleUpload(req.files[0]);
  }
  const result = await db.createUpdate({ title, content, sentiment: parseInt(sentiment) || 5, photo, update_date });
  if (req.files && req.files.length) {
    const photoPaths = await Promise.all(req.files.map(f => handleUpload(f)));
    await db.addUpdatePhotos(result.lastInsertRowid, photoPaths);
  }
  const snippet = content.substring(0, 100).replace(/\n/g, ' ') + (content.length > 100 ? '...' : '');
  sendPushNotifications(
    'New Update: ' + title,
    snippet,
    '/update/' + result.lastInsertRowid
  ).catch(console.error);
  res.redirect('/admin');
}));

app.get('/admin/edit/:id', requireAuth, asyncHandler(async (req, res) => {
  const update = await db.getUpdate(req.params.id);
  if (!update) return res.status(404).render('404');
  const photos = await db.getUpdatePhotos(update.id);
  res.render('admin/editor', { update, photos });
}));

app.post('/admin/edit/:id', requireAuth, upload.array('photos', 20), asyncHandler(async (req, res) => {
  const { title, content, sentiment, update_date } = req.body;
  if (req.files && req.files.length) {
    const limitErr = await checkStorageLimit(req.files);
    if (limitErr) {
      const update = await db.getUpdate(req.params.id);
      const photos = await db.getUpdatePhotos(req.params.id);
      return res.status(400).render('admin/editor', { update, photos, error: limitErr });
    }
  }
  let photo = null;
  if (req.files && req.files.length) {
    photo = await handleUpload(req.files[0]);
  }
  await db.editUpdate(req.params.id, { title, content, sentiment: parseInt(sentiment) || 5, photo, update_date });
  if (req.files && req.files.length) {
    const photoPaths = await Promise.all(req.files.map(f => handleUpload(f)));
    await db.addUpdatePhotos(req.params.id, photoPaths);
  }
  res.redirect('/admin');
}));

app.post('/admin/photos/reorder', requireAuth, express.json(), asyncHandler(async (req, res) => {
  const { photoIds } = req.body;
  if (Array.isArray(photoIds)) {
    await db.reorderUpdatePhotos(photoIds.map(Number));
  }
  res.json({ ok: true });
}));

app.post('/admin/photo/delete/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.deleteUpdatePhoto(req.params.id);
  res.redirect('back');
}));

app.post('/admin/delete/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.deleteUpdate(req.params.id);
  res.redirect('/admin');
}));

app.post('/admin/pin/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.pinUpdate(req.params.id);
  res.redirect('/admin');
}));

app.post('/admin/unpin/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.unpinUpdate(req.params.id);
  res.redirect('/admin');
}));

// Vitals
app.get('/admin/vitals', requireAuth, asyncHandler(async (_req, res) => {
  const vitals = await db.getVitals(30);
  const latest = await db.getLatestVitals();
  res.render('admin/vitals', { vitals, latest, editing: null });
}));

app.post('/admin/vitals', requireAuth, asyncHandler(async (req, res) => {
  await db.createVital({
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
}));

app.get('/admin/vitals/edit/:id', requireAuth, asyncHandler(async (req, res) => {
  const vital = await db.getVital(req.params.id);
  if (!vital) return res.status(404).render('404');
  const vitals = await db.getVitals(30);
  res.render('admin/vitals', { vitals, latest: vital, editing: vital });
}));

app.post('/admin/vitals/edit/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.editVital(req.params.id, {
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
}));

app.post('/admin/vitals/delete/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.deleteVital(req.params.id);
  res.redirect('/admin/vitals');
}));

// Milestones
app.get('/admin/milestones', requireAuth, asyncHandler(async (_req, res) => {
  const milestones = await db.getMilestonesByCategory();
  res.render('admin/milestones', { milestones });
}));

app.post('/admin/milestones/achieve/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.achieveMilestone(req.params.id, req.body.achieved_date);
  res.redirect('/admin/milestones');
}));

app.post('/admin/milestones/unachieve/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.unachieveMilestone(req.params.id);
  res.redirect('/admin/milestones');
}));

app.post('/admin/milestones/new', requireAuth, asyncHandler(async (req, res) => {
  const category = req.body.category;
  if (!category) return res.redirect('/admin/milestones');
  await db.createMilestone({
    category,
    title: req.body.title,
    description: req.body.description,
    sort_order: req.body.sort_order,
  });
  res.redirect('/admin/milestones');
}));

app.post('/admin/milestones/delete/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.deleteMilestone(req.params.id);
  res.redirect('/admin/milestones');
}));

// Settings
app.get('/admin/settings', requireAuth, (_req, res) => {
  res.render('admin/settings');
});

app.post('/admin/settings', requireAuth, upload.single('site_logo'), asyncHandler(async (req, res) => {
  const fields = ['baby_name', 'display_name', 'birth_date', 'birth_time', 'gestational_age_weeks', 'gestational_age_days', 'due_date', 'birth_weight_grams', 'nicu_name', 'theme'];
  for (const field of fields) {
    if (req.body[field] !== undefined) await db.setSetting(field, req.body[field]);
  }
  if (req.file) {
    const limitErr = await checkStorageLimit([req.file]);
    if (!limitErr) {
      const logoUrl = await handleUpload(req.file);
      await db.setSetting('site_logo', logoUrl);
    }
  }
  res.redirect('/admin/settings');
}));

app.post('/admin/settings/reset-logo', requireAuth, asyncHandler(async (_req, res) => {
  await db.setSetting('site_logo', '');
  res.redirect('/admin/settings');
}));

// ============ PUSH NOTIFICATIONS ============

app.post('/api/push/subscribe', requireViewer, asyncHandler(async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }
  await db.savePushSubscription(endpoint, keys.p256dh, keys.auth);
  res.json({ success: true });
}));

app.post('/api/push/unsubscribe', requireViewer, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  await db.deletePushSubscription(endpoint);
  res.json({ success: true });
}));

async function sendPushNotifications(title, body, url) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  const subscriptions = await db.getAllPushSubscriptions();
  const payload = JSON.stringify({ title, body, url, tag: 'baby-update-' + Date.now() });

  for (const sub of subscriptions) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
    };
    webpush.sendNotification(pushSub, payload).catch(async (err) => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await db.deletePushSubscription(sub.endpoint).catch(() => {});
      }
    });
  }
}

// Dynamic manifest.json
const THEME_COLORS = {
  rose: '#e44b6a', ocean: '#0ea5e9', lavender: '#a855f7', sunset: '#f97316', forest: '#10b981',
  'rose-light': '#e44b6a', 'ocean-light': '#0ea5e9', 'lavender-light': '#a855f7', 'sunset-light': '#f97316', 'forest-light': '#10b981',
};

app.get('/manifest.json', asyncHandler(async (_req, res) => {
  const settings = await db.getSettings();
  const logo = settings.site_logo || '/images/white-footprint.png';
  const name = settings.baby_name || 'Baby';
  const theme = settings.theme || 'rose';
  const themeColor = THEME_COLORS[theme] || '#e44b6a';
  const isLight = theme.endsWith('-light');
  res.json({
    name: name + "'s Journey",
    short_name: name + "'s Journey",
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
}));

// Error handler
app.use((err, _req, res, _next) => {
  console.error('Server error:', err);
  res.status(500).send('Internal Server Error');
});

// 404
app.use((_req, res) => {
  res.status(404).render('404');
});

// Async startup: init DB then listen
async function main() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`BabyJourney running on http://localhost:${PORT}`);
  });
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
