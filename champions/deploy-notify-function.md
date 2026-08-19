# Deploy the updated email function (sends to HR + you too)

The confirmation email function now also sends an internal notification —
with the applicant's name, institution, track, phone and email — to
`HR@mobihealthinternational.com` and (temporarily, for testing)
`kenniskalu18@gmail.com` on every submission. You asked me to remove your
own email from that list later — when you're ready, just tell me and I'll
send you the one-line edit.

This lives on Supabase, not in your GitHub repo, so it needs to be
redeployed there directly. Easiest way — no command line needed:

1. Supabase Dashboard → your project → **Edge Functions** (left sidebar).
2. If `champions-notify` already exists, click it, then find the option to
   **edit/redeploy** its code. If it doesn't exist yet, click **New
   Function**, name it exactly `champions-notify`.
3. Delete whatever code is in the editor and paste in the full contents of
   `supabase/functions/champions-notify/index.ts` from this project (I've
   attached it separately).
4. Click **Deploy**.
5. Make sure `RESEND_API_KEY` is set as a secret (Edge Functions →
   Secrets, or Project Settings → Edge Functions). If you haven't set this
   up yet, create a free account at resend.com, grab an API key, and add it
   there — without it, applications still save fine, they just won't
   trigger any emails.

That's it — every new submission will now email the applicant a
confirmation *and* send HR (and you) an internal notification.
