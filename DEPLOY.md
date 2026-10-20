# Deploying Domain Engine to the VPS

Target: Hostinger KVM 2 (`root@200.97.170.1`), next to the n8n and email-finder stacks.
Nothing here touches those stacks. HTTPS comes from the existing Traefik
(`n8n_default` network, `mytlschallenge` resolver), the same way email-finder works.

| Stack | Folder on the VPS | What runs |
|---|---|---|
| Supabase (trimmed) | `/docker/domain-engine-db` | db, auth, rest, meta, studio, api-gw. All ports on `127.0.0.1` only |
| App | `/docker/domain-engine` | `web` (Next.js) |

## 1. Supabase

From your computer, in this project folder:

```bash
ssh -i ~/.ssh/hostinger_vps root@200.97.170.1 "mkdir -p /opt/domain-engine-deploy/supabase"
scp -i ~/.ssh/hostinger_vps deploy/supabase/* root@200.97.170.1:/opt/domain-engine-deploy/supabase/
ssh -i ~/.ssh/hostinger_vps root@200.97.170.1 "sh /opt/domain-engine-deploy/supabase/setup.sh domains.srv1826728.hstgr.cloud"
```

`setup.sh` copies the official Supabase Docker files (already cloned to
`/opt/src/supabase`), generates every secret into `/docker/domain-engine-db/.env`,
turns off Realtime, Storage, imgproxy, Edge Functions and the pooler, and starts
the rest. Re-running it is safe: it never overwrites an existing `.env` or database.

## 2. App files

```bash
ssh -i ~/.ssh/hostinger_vps root@200.97.170.1 "mkdir -p /docker/domain-engine"
scp -r -i ~/.ssh/hostinger_vps package.json package-lock.json next.config.ts tsconfig.json Dockerfile .dockerignore src public scripts supabase deploy root@200.97.170.1:/docker/domain-engine/
```

(Once the project is in a Git repository, `git pull` replaces this step.)

## 3. Database role and settings

On the VPS:

```bash
cd /docker/domain-engine/deploy/app
cp .env.example .env
APP_DB_PASSWORD=$(openssl rand -hex 24)
docker exec -i supabase-db psql -U postgres -d postgres -c "create role domain_engine login password '$APP_DB_PASSWORD'; grant create on schema public to domain_engine;"
sed -i "s|CHANGE_ME|$APP_DB_PASSWORD|" .env
grep -E '^(ANON_KEY|SERVICE_ROLE_KEY)=' /docker/domain-engine-db/.env   # copy into .env as SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
nano .env   # API keys, SMARTLEAD_WEBHOOK_TOKEN=$(openssl rand -hex 20)
chmod 600 .env
```

## 4. Migrate and start

```bash
cd /docker/domain-engine/deploy/app
docker compose run --rm migrate
docker compose up -d --build web
curl -s https://domains.srv1826728.hstgr.cloud/api/health   # {"ok":true}
```

## 5. First login

Sign-up is off, so accounts are created by an admin. From your computer
(PowerShell, cmd or bash), once per person:

```bash
ssh -t -i ~/.ssh/hostinger_vps root@200.97.170.1 bash /docker/domain-engine/deploy/create-user.sh
```

It asks for the email and password (hidden, typed twice).

## 6. Backups

```bash
crontab -e
# add:
15 3 * * * sh /docker/domain-engine/deploy/backup.sh >> /var/log/domain-engine-backup.log 2>&1
```

For copies off the server, set up an rclone remote named `offsite` (Backblaze B2,
S3 or Google Drive). Restore drill:
`docker exec -i supabase-db pg_restore -U postgres -d postgres --clean < /var/backups/domain-engine/<file>.dump`

## Studio (database admin)

Studio is not on the internet. Open a tunnel, then visit http://localhost:54321
(user `admin`, password = `DASHBOARD_PASSWORD` in `/docker/domain-engine-db/.env`):

```bash
ssh -i ~/.ssh/hostinger_vps -N -L 54321:127.0.0.1:54321 -L 54322:127.0.0.1:54322 root@200.97.170.1
```

The same tunnel lets local development use the real database on port 54322.

## Updating

```bash
cd /docker/domain-engine/deploy/app
docker compose run --rm migrate && docker compose up -d --build web
```
