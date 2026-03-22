# Khedmah — Pre-Launch Checklist

Work through this list in order before opening the platform to real users.
Check off each item only after it has been **verified in production**, not staging.

---

## 🔐 Security

- [ ] All `CHANGE_ME` values replaced in `.env` on the production server
- [ ] JWT_SECRET and JWT_REFRESH_SECRET are different, each ≥64 random characters
      (`openssl rand -hex 64`)
- [ ] `NODE_ENV=production` is set (disables stack traces in error responses, enables rate limit storage)
- [ ] Moyasar LIVE keys (`sk_live_`, `pk_live_`) are used — not test keys
- [ ] ALLOWED_ORIGINS contains only production domains (no localhost)
- [ ] Redis is password-protected (`REDIS_PASSWORD` set + `requirepass` in redis.conf)
- [ ] Database password is strong (≥32 chars) and not the docker-compose default ("secret")
- [ ] SSL certificate is valid and auto-renewing (check: `certbot renew --dry-run`)
- [ ] HTTPS redirect is active (HTTP → HTTPS in nginx.conf)
- [ ] `fail2ban` is running: `systemctl status fail2ban`
- [ ] Firewall allows only ports 22, 80, 443: `ufw status`
- [ ] No `.env` files committed to git: `git log --all -- .env`
- [ ] Docker containers running as non-root user (confirmed in Dockerfile: `USER khedmah`)

---

## 🗄️ Database

- [ ] `prisma migrate deploy` ran successfully against production DB with zero errors
- [ ] Seed data (`prisma db seed`) was NOT run on production
- [ ] Admin account created via API (not hardcoded seed credentials)
- [ ] Default demo users do NOT exist in production DB:
      `SELECT email FROM "User" WHERE email IN ('customer@demo.sa','khalid@demo.sa');`
- [ ] DB backup script ran successfully at least once: `bash docker/backup.sh`
- [ ] Backup file uploaded to S3 and is readable
- [ ] Daily backup cron is active: `crontab -l -u khedmah`
- [ ] DB connection pool size is appropriate (`DATABASE_URL?connection_limit=10`)

---

## 📧 Email

- [ ] SendGrid (or SMTP) is configured with production API key
- [ ] Verification email sends correctly (test with a real email address)
- [ ] Password reset email sends correctly
- [ ] `SMTP_FROM` is a verified sender domain in SendGrid
- [ ] `APP_BASE_URL` is set to `https://khedmah.sa` (links in emails go to the right place)
- [ ] `ADMIN_EMAIL` and `REPORT_RECIPIENTS` are real monitored addresses

---

## 💳 Payments

- [ ] Moyasar dashboard is in LIVE mode (not test mode)
- [ ] Webhook URL is registered in Moyasar dashboard: `https://api.khedmah.sa/api/v1/payments/webhook`
- [ ] Webhook secret (`MOYASAR_WEBHOOK_SECRET`) matches what Moyasar sends
- [ ] Test payment of 1 SAR processed end-to-end (Moyasar → webhook → escrow created)
- [ ] Platform fee (15%) is correctly deducted on escrow release
- [ ] VAT (15%) appears correctly on invoices

---

## 🔔 Notifications

- [ ] Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT`) are for production Firebase project
- [ ] Test push notification delivered to a real device
- [ ] Email notifications triggered correctly for: new quote, quote accepted, escrow released

---

## 🚀 Infrastructure

- [ ] All 5 containers running: `docker compose ps` shows api, postgres, redis, nginx, and health checks passing
- [ ] `/api/v1/health` returns `{"status":"ok"}` from outside the server
- [ ] `/api/v1/health/ready` confirms DB + Redis connectivity
- [ ] API responds within 500ms for simple requests (check with `curl -w "%{time_total}"`)
- [ ] Log rotation is configured: `cat /etc/docker/daemon.json` shows max-size/max-file
- [ ] Disk space is adequate: `df -h` (≥20GB free)
- [ ] Memory is adequate: `free -h` (≥1GB free)
- [ ] Sentry DSN is configured and test error is captured in Sentry dashboard
- [ ] Slack webhook sends deploy notifications (run a manual deploy to verify)

---

## 🌐 Frontend

- [ ] `KHEDMAH_API_URL` GitHub secret is set to `https://api.khedmah.sa/api/v1`
- [ ] Frontend deployed to GitHub Pages and accessible at production URL
- [ ] `login.html` → API login flow works (no localhost references)
- [ ] `register-customer.html` → real registration + email verification
- [ ] Payment flow (`payment-escrow.html`) uses live Moyasar publishable key
- [ ] No demo/test credentials visible anywhere in the UI
- [ ] All 36 pages load without console errors in production

---

## 📊 Monitoring

- [ ] Uptime monitor configured (e.g., UptimeRobot / Better Uptime) for:
      - `https://api.khedmah.sa/api/v1/health/live` (backend)
      - `https://khedmah.sa` (frontend)
- [ ] Sentry alert rules configured:
      - Error rate spike (>10 errors/min)
      - New issue notification to admin email
- [ ] Payment failure alert: monitor for `payment.failed` events in logs or Sentry
- [ ] Backup failure alert: check cron log daily `tail -f /var/log/khedmah-backup.log`

---

## 📋 Legal & Business

- [ ] Terms of Service page is live and linked from registration
- [ ] Privacy Policy is live and linked from registration
- [ ] Platform fee (15%) has been agreed with legal
- [ ] VAT registration number is included on invoices
- [ ] Moyasar account is verified and approved for live transactions
- [ ] Content (Arabic text) has been reviewed for correctness by a native speaker

---

## 🧪 Final Smoke Test (do this last)

1. Register a new customer with a real email address
2. Verify email via the link received
3. Log in, create a service request
4. Log in as a test provider, submit a quote
5. As customer, accept the quote
6. Process a real Moyasar payment (use the 1 SAR test service)
7. Provider completes the work
8. Customer confirms and releases escrow
9. Check provider wallet balance increased by correct amount (service fee - 15%)
10. Both users rate each other
11. Download the invoice PDF
12. Log out

**Only proceed to public launch after all items above are checked. ✓**
