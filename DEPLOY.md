# Deploying NetBazar — Turso + Vercel

A step-by-step guide to putting the shop database on **Turso** (hosted SQLite) and the
app on **Vercel**. Both have free tiers that comfortably fit one shop.

Read [Before you start](#before-you-start) first — there is one decision to make that is
hard to undo.

---

## Contents

- [Before you start](#before-you-start)
- [1. Put the database on Turso](#1-put-the-database-on-turso)
- [2. Generate a session secret](#2-generate-a-session-secret)
- [3. Push the code to GitHub](#3-push-the-code-to-github)
- [4. Deploy on Vercel](#4-deploy-on-vercel)
- [5. First login](#5-first-login)
- [6. A custom domain](#6-a-custom-domain)
- [Running locally afterwards](#running-locally-afterwards)
- [Backups](#backups)
- [Troubleshooting](#troubleshooting)

---

## Before you start

**Your till will now depend on the internet.** The app was built to work offline — every
font and script is served from the app itself, precisely so a dropped connection could
never stop you billing a customer. Once it is hosted, no internet means no billing.

Three ways people handle that:

| Approach | Good for |
|---|---|
| **Hosted only** | You accept the risk; the shop has reliable internet |
| **Local till + hosted copy** | Bill locally, view from home. Two separate databases |
| **Local only** | Keep as-is; reach it over the shop's LAN from a phone |

This guide covers **hosted**. If you want the second option, deploy as below but keep
running the local copy for actual billing.

**What you need:** a [GitHub](https://github.com) account, a [Turso](https://turso.tech)
account, and a [Vercel](https://vercel.com) account. All three sign up free with GitHub.

### Do the database first

Follow the steps in order: **Turso → GitHub → Vercel**. Vercel needs the database URL and
token *while you set the project up*, because the app reads them at startup.

Deploying before the database exists does not half-work — the app cannot open a database at
all, so the function crashes and every page fails. It is recoverable (add the variables,
redeploy) but there is nothing to see until you do. Creating the Turso database first costs
two minutes and skips that entirely.

---

## 1. Put the database on Turso

### Install the CLI

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup      # or: turso auth login
```

### Create the database from your existing data

Run this **from the project folder**, so it picks up your real `shop.db`:

```bash
turso db create netbazar --from-file shop.db
```

`--from-file` uploads your current products, sales and purchases. Your local `shop.db` is
not modified.

> Creating an empty database instead? Drop `--from-file`. The app creates its own tables
> on first start, so an empty database is fine — you just begin with no history.

### Get the two values the app needs

```bash
turso db show netbazar --url
turso db tokens create netbazar
```

The first prints a `libsql://…` URL, the second a long token. Keep both to hand — they go
into Vercel in step 4. **The token is a password to your business data; do not commit it
or paste it anywhere public.**

---

## 2. Generate a session secret

This signs the login cookie. Without it, logins stop working every time the app restarts.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy the long hex string it prints.

---

## 3. Push the code to GitHub

`shop.db` and `.env` are gitignored, so your data and secrets stay out of the repository.

```bash
git remote add origin https://github.com/YOUR-USERNAME/netbazar.git
git push -u origin netbazar
```

Make the repository **private** unless you have a reason not to.

---

## 4. Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the repository.
2. Leave the framework preset as **Other**. There is no build step — the CSS is committed.
3. Before clicking Deploy, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `DATABASE_URL` | the `libsql://…` URL from step 1 |
| `DATABASE_AUTH_TOKEN` | the token from step 1 |
| `JWT_SECRET` | the hex string from step 2 |
| `ADMIN_EMAIL` | the email you want to log in with |
| `ADMIN_PASSWORD` | a strong password — **not** `admin123` |
| `TZ` | `Asia/Dhaka` |

`NODE_ENV` is set to `production` by Vercel automatically, which is what marks the login
cookie HTTPS-only.

4. Click **Deploy**.

`ADMIN_EMAIL` and `ADMIN_PASSWORD` are used **only if no admin account exists yet**. If you
imported an existing `shop.db`, your old account came with it and these are ignored.

---

## 5. First login

Open the URL Vercel gives you (`something.vercel.app`) and sign in.

- **Imported an existing database?** Use your old email and password. The app notices the
  old password was stored as plain text, accepts it once, and immediately replaces it with
  a bcrypt hash.
- **Started empty?** Use `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

**Then change the password from the dashboard** (the **Password** button in the top bar),
so the real password is not sitting in Vercel's environment variables.

---

## 6. A custom domain

The free `something.vercel.app` subdomain works and is HTTPS out of the box.

For your own domain, note that genuinely free domains have largely disappeared — Freenom's
free `.tk`/`.ml` are gone. Budget roughly **৳1,200/year** at Namecheap, Cloudflare or a
local registrar. Then in Vercel: **Settings → Domains → Add**, and set the DNS records it
shows you. The certificate is issued automatically.

---

## Running locally afterwards

The shop PC still works exactly as before, with no Turso and no internet:

```bash
npm start
```

With no `DATABASE_URL`, the app uses the local `shop.db` file. One driver handles both, so
there are no separate code paths to keep in step.

To run locally *against* the hosted database — handy for checking something — create a
`.env` from `.env.example` and start with those variables loaded:

```bash
node --env-file=.env server.js
```

> These are two **separate** databases. Sales recorded locally do not appear on the hosted
> site, and vice versa. Pick one as the real one.

---

## Backups

Turso keeps its own point-in-time backups, but keep your own copy too:

```bash
turso db shell netbazar ".dump" > netbazar-$(date +%F).sql
```

For the local file, the `sqlite3` CLI is usually not installed on a shop PC, so use the
driver that ships with the app:

```bash
node -e "new (require('@libsql/client').createClient)({url:'file:shop.db'}).execute(\"VACUUM INTO 'backup.db'\")"
```

---

## Troubleshooting

**Every page fails, or the deployment log says the database could not be opened**
`DATABASE_URL` or `DATABASE_AUTH_TOKEN` is missing or wrong — most often because the project
was deployed before the Turso database existed. The log says which of the two cases it is.
Fix them under Vercel → Settings → Environment Variables, then **redeploy**: changing a
variable does not redeploy on its own, so the old build keeps failing until you do.

**"Database unavailable" on every page**
The database opened but the tables could not be created — usually an auth token that is
valid but lacks write access. Reissue it with `turso db tokens create netbazar`.

**Logged out constantly, or after every deploy**
`JWT_SECRET` is missing, so each instance signs cookies differently. Set it and redeploy.

**"Invalid email or password" with the right password**
If you imported a database, the account is whatever was in it — `ADMIN_EMAIL` is ignored
when an admin already exists. Check with `turso db shell netbazar "SELECT email FROM admin"`.

**Sale times are hours off**
`TZ` is not set to `Asia/Dhaka`. Vercel servers run UTC, which is six hours behind.

**Login works but nothing loads**
Open the browser console. Repeated `401`s mean the cookie is not coming back — usually the
site is being opened over `http://` rather than `https://`, and the cookie is HTTPS-only in
production.
