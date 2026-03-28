# BabyJourney

A free, self-hosted NICU baby journey tracker for families. Track updates, vitals, milestones, and share progress with loved ones.

**Built with:** Node.js, Express, EJS, Turso (database), Cloudinary (images)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/chucksupport/BabyJourney)

## Setup

### 1. Deploy to Render

Click the button above. You'll be prompted to fill in environment variables.

### 2. Create a Turso Database (free)

1. Sign up at [turso.tech](https://turso.tech)
2. Create a new database
3. Copy the **Database URL** and generate an **Auth Token**

### 3. Create a Cloudinary Account (free)

1. Sign up at [cloudinary.com](https://cloudinary.com)
2. Copy your **Cloud Name**, **API Key**, and **API Secret** from the dashboard

### 4. Set Environment Variables

| Variable | Description |
|----------|-------------|
| `ADMIN_PASSWORD` | Password to access the admin dashboard |
| `VIEWER_PASSWORD` | Password for family/friends to view the site |
| `TURSO_DATABASE_URL` | Your Turso database URL (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | Your Turso auth token |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Your Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Your Cloudinary API secret |
| `STORAGE_LIMIT_MB` | Image storage limit in MB (default: 1024) |

Optional:
| Variable | Description |
|----------|-------------|
| `VAPID_PUBLIC_KEY` | For push notifications (generate with `npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | For push notifications |

### 5. Custom Domain (optional)

Add a CNAME record pointing to your Render service URL, then add the custom domain in Render settings.

## Local Development

```bash
git clone https://github.com/chucksupport/BabyJourney.git
cd BabyJourney
npm install
npm run dev
```

No env vars needed locally — uses a local SQLite file and disk uploads by default.

## Features

- Updates with multiple photos
- Vitals tracking with charts
- Milestone tracking (pre-loaded NICU milestones)
- Push notifications
- PWA (installable, works offline)
- Themeable (6 color themes, light/dark)
- 1GB storage limit per instance (configurable)
- JSON backup/export

Made with love by [Chuck.Support](https://chuck.support)
