# Shree Pharma: website + email dashboard

One Cloudflare Worker that serves:

- **The public website** (`/`): product catalogue, brochure download, quote form, WhatsApp and email buttons.
- **The private dashboard** (`/app`): password login, CSV lead import, Gmail drafts, approve-and-send with a daily limit,
  automatic follow-up after N business days in the same email thread, reply / bounce / unsubscribe detection,
  website quote requests, alerts to your main inbox, and lead export.

Runs on Cloudflare's free plan with a D1 database. Gmail is connected with Google sign-in (scope `gmail.modify`).

Follow **Setup-Guide.pdf** step by step. You never need to edit code.

## Secrets (Cloudflare > Worker > Settings > Variables and Secrets)

| Name | What it is |
|---|---|
| `ADMIN_PASSWORD` | Your dashboard password, at least 10 characters (12+ recommended) |
| `GOOGLE_CLIENT_ID` | From Google Cloud > Clients (ends with `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud > Clients |

## Timer

Every 10 minutes: check replies, send up to 3 approved emails, and on weekdays 9 AM to 8 PM IST prepare drafts up to your daily limit.
A summary email goes to your alert address at about 9:30 AM IST on weekdays when drafts are waiting.
