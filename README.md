# Ayurvia / Auryvia Infotech ? Website

Website for Auryvia Infotech (digital agency) with Express backend, admin panel, live chat, and Google Sign-In.

## Run locally

```bash
npm install
npm start
```

Create a `.env` file with: `PORT`, `MONGO_URI`, `EMAIL_USER`, `EMAIL_PASSWORD`, `ADMIN_PASS`.

## Deploy on Render

1. Connect the repo: [https://github.com/auryviainfotech/final-auryvia](https://github.com/auryviainfotech/final-auryvia).
2. **Build command:** `npm install` (the repo uses npm via `package-lock.json`).
3. **Start command:** `npm run start`.
4. **Environment variables** ? in Render Dashboard ? your service ? **Environment**, add:

   | Key              | Description / example                                      |
   |------------------|-----------------------------------------------------------|
   | `MONGO_URI`      | MongoDB connection string (e.g. `mongodb+srv://...`)     |
   | `EMAIL_USER`     | Gmail address for alerts and client emails                |
   | `EMAIL_PASSWORD` | Gmail app password (16 chars)                            |
   | `ADMIN_PASS`     | Admin panel password (default in code: `Ayurvia2026`)     |
   | `SITE_URL`       | Public site URL (e.g. `https://final-auryvia.onrender.com`) – used in client email footers |
   | `CONTACT_PHONE`  | Company phone (e.g. `+91 98765 43210`) – shown in client emails |

   `PORT` is set by Render; you don?t need to add it.

5. Deploy. The app will stay up; MongoDB and email alerts work only after these env vars are set.

## Links

- **Live:** https://final-auryvia.onrender.com  
- **Admin:** https://final-auryvia.onrender.com/admin/login.html  
