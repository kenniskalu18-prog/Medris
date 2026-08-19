# Mobihealth Campus Champions — Application Portal

A recruitment portal for the **Mobihealth Campus Champions** programme at the
University of Lagos. Applicants apply through a multi-step form; approved
administrators review, filter, and manage applications through a secure
dashboard at `/champions/admin.html`.

This folder is self-contained and lives inside the existing Medris repo. It
does not touch or depend on any other page in this repository.

- Applicant site: `champions/index.html`
- Admin dashboard: `champions/admin.html`
- Database schema: `supabase/champions_schema.sql`
- Confirmation email: `supabase/functions/champions-notify` (Supabase Edge Function)

Everything is already wired up and live against this project's Supabase
instance — `champions/js/config.js` has the project URL and public anon key
baked in (that's normal and safe: real protection is the Row Level Security
policies in the schema, not hiding this key). You do **not** need to create a
new Supabase project or re-run the schema unless you want a fresh/separate
instance.

## How it works, in plain terms

- **Applicants** never log in. They fill the form and hit submit — their
  data is written straight into the `champion_applications` table and their
  files go into two private Supabase Storage buckets.
- **Admins** sign in with a magic link sent to their email (Supabase Auth).
  Only emails present in the `champion_admins` table (with `status =
  active`) can see any application data — this is enforced in the database
  itself via Row Level Security, not just hidden in the UI.
- The **Super Admin** (seeded as `kennyskalu18@gmail.com`) can add or remove
  other admins from the "Manage Administrators" screen. Regular admins can
  view/manage applications but cannot touch the admin list.
- No secret keys ever live in the browser. The only key shipped to the
  browser is the Supabase **anon/public** key, which is designed to be
  public and is restricted by RLS.

## 1. Deploying to Vercel

1. Commit and push this repo to GitHub (already done if you're reading this
   from the repo).
2. In Vercel, click **Add New → Project**, and import this GitHub repo.
3. Vercel needs no build step — this is static HTML/CSS/JS. Leave the
   "Framework Preset" as **Other**, and leave build/output settings blank.
4. Deploy. Your applicant site will be live at:
   `https://<your-vercel-domain>/champions/`
   and the admin dashboard at:
   `https://<your-vercel-domain>/champions/admin.html`
5. No environment variables are required for the champions portal itself —
   the Supabase URL/anon key are already in `champions/js/config.js`.

## 2. The database (already set up)

The schema in `supabase/champions_schema.sql` has already been applied to
this project's Supabase instance. If you ever want to reset or re-apply it
(e.g. on a brand-new Supabase project):

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Go to **SQL Editor → New query**.
3. Paste the entire contents of `supabase/champions_schema.sql` and click
   **Run**.
4. This creates:
   - `champion_applications` — every submitted application
   - `champion_admins` — the approved admin allow-list (seeded with the
     Super Admin email)
   - `champion_settings` — a single row controlling the programme name,
     description, open/closed state, and deadline
   - `champion_status_history` / `champion_activity_log` — audit trails
   - Two **private** Storage buckets: `champion-photos` and `champion-cvs`
   - All Row Level Security policies

If you point this portal at a **different** Supabase project, update the
`MOBIHEALTH_SUPABASE_URL` and `MOBIHEALTH_SUPABASE_ANON_KEY` values in
`champions/js/config.js` (find them under Project Settings → API in your
Supabase dashboard).

## 3. Enabling admin login (Supabase Auth)

Admins sign in via **magic link** (no passwords to manage):

1. In Supabase, go to **Authentication → Providers** and confirm **Email**
   is enabled (it is by default).
2. Under **Authentication → URL Configuration**, add your deployed admin URL
   (e.g. `https://yourdomain.com/champions/admin.html`) to the **Redirect
   URLs** allow-list, and set it as the **Site URL** if this is your primary
   deployment.
3. That's it — when an admin enters their email on `admin.html`, Supabase
   emails them a one-time login link. Clicking it signs them in. The portal
   then checks the `champion_admins` table to decide whether they're allowed
   in.

## 4. Adding the first admin / more admins

The Super Admin (`kennyskalu18@gmail.com`) is already seeded in the
database by the schema script. To add more admins:

- **From the dashboard (recommended):** sign in as the Super Admin, go to
  **Manage Administrators**, enter an email, click **Add Admin**.
- **Directly in SQL**, if you ever need to bootstrap a different Super
  Admin:
  ```sql
  insert into public.champion_admins (email, role, status, added_by)
  values ('someone@example.com', 'super_admin', 'active', 'system');
  ```

## 5. Confirmation emails (optional but recommended)

Confirmation emails are sent via a Supabase Edge Function
(`supabase/functions/champions-notify`) so the email provider's secret key
never touches the browser or Vercel. It's already deployed. To activate it:

1. Create a free account at [resend.com](https://resend.com) and grab an API
   key.
2. In your terminal (with the [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in):
   ```sh
   supabase secrets set RESEND_API_KEY=re_xxxxxxxx --project-ref ovklnoroyxobijgvsyfp
   ```
3. (Optional) Verify your own sending domain in Resend, then set:
   ```sh
   supabase secrets set CHAMPIONS_EMAIL_FROM="Mobihealth <noreply@yourdomain.com>" --project-ref ovklnoroyxobijgvsyfp
   ```
4. If you skip this step, applications still submit and save perfectly —
   the portal just won't send a confirmation email (it fails silently).

## 6. Opening / closing applications & changing the deadline

Sign in to the admin dashboard as any admin and go to **Application
Settings**. From there you can:

- Toggle **Application Status** between Open / Closed (instantly disables
  the public form when Closed)
- Change the **Application Deadline** (the public countdown and auto-close
  behaviour both read this value)
- Update the programme name/description

No code changes or redeploys needed for any of this.

## 7. Adding your real logo & campus photos

This build ships with a lightweight CSS/SVG ambulance mark as a placeholder
brand icon (used across the header, hero, and admin login) so the site
looks correct without any binary assets committed. To use your actual
Mobihealth logo and campus photography:

1. Drop your logo file at `champions/assets/logo.png` and your hero photo at
   `champions/assets/unilag-hero.jpg`.
2. In `champions/index.html`, replace the inline SVG brand mark(s) with
   `<img src="assets/logo.png" alt="Mobihealth">`, keeping the existing
   sizing classes.
3. The hero section already looks for `champions/assets/unilag-hero.jpg` — 
   it will pick it up automatically once the file exists.

## 8. Local testing

Because this is a static site calling Supabase directly, you can preview it
with any static file server, e.g.:

```sh
cd champions
npx serve .
```

Then open `http://localhost:3000` for the applicant site and
`http://localhost:3000/admin.html` for the dashboard.

## What's included, end to end

- Mobile-first multi-step application form (5 steps, progress bar, per-step
  validation, file uploads, duplicate-application prevention)
- Public countdown to the deadline, auto-closing form after it passes
- Success screen with a generated reference number (`MOBI-YYYY-00001`)
- Optional confirmation email
- Admin magic-link login restricted to an approved allow-list enforced by
  Row Level Security (not just UI checks)
- Dashboard stats, searchable/filterable applications table, CSV export
- Full application detail view with private admin notes and status changes
  (with audit history)
- Super Admin / Admin roles for managing who can access the dashboard
- Admin activity log
