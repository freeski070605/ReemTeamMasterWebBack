# ReemTeamMasterWebBack

## Render production deploy

Use a Node web service.

Build command:
```
npm ci && npm run build
```

Start command:
```
npm run start
```

Environment variables (set in Render):
- `MONGODB_URI`
- `REDIS_URL`
- `JWT_SECRET`
- `FRONTEND_URL`
- `FRONTEND_URLS` (recommended for multiple allowed web origins, for example `https://reemteamapp.com,https://www.reemteamapp.com`)
- `BACKEND_URL`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_ENVIRONMENT` (`sandbox` or `production`)
- `SQUARE_VIP_PLAN_ID`
- `SQUARE_VIP_PRICE_CENTS` (optional, defaults to `499`)
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SECRET`
- `SQUARE_WEBHOOK_SECRETS` (optional comma-separated fallback list when multiple Square subscriptions are active)
- `SQUARE_WEBHOOK_NOTIFICATION_URL` (optional override; defaults to `${BACKEND_URL}/api/webhook/square-webhook`; `/api/webhooks/square` is also supported)
- `SQUARE_RTC_BUNDLE_4_99_CATALOG_OBJECT_ID` (optional)
- `SQUARE_RTC_BUNDLE_9_99_CATALOG_OBJECT_ID` (optional)
- `SQUARE_RTC_BUNDLE_19_99_CATALOG_OBJECT_ID` (optional)
- `MIN_WITHDRAWAL_AMOUNT`

If `FRONTEND_URL` / `FRONTEND_URLS` are omitted, the backend now falls back to allowing:
- `https://reemteamapp.com`
- `https://www.reemteamapp.com`
- `http://localhost:3000`

## Square RTC purchase flow

- Frontend calls `POST /api/payment/create-rtc-checkout` with a configured `bundleId`.
- Backend creates a Square payment link with RTC metadata (`purchaseType=rtc_bundle`, `bundleId`, `userId`).
- If you already created Square catalog products/variations, set the matching `SQUARE_RTC_BUNDLE_*_CATALOG_OBJECT_ID` environment variable for that deployment. Sandbox and production catalog IDs are different objects.
- Square sends webhook events (for example `payment.updated`) to `/api/webhooks/square` (or legacy `/api/webhook/square-webhook`).
- Backend verifies the webhook signature and credits RTC only after a completed payment.

## Square environment notes

- Square customer IDs, subscription IDs, plan variation IDs, and catalog object IDs are environment-specific.
- After switching from sandbox to production, reuse the production `SQUARE_VIP_PLAN_ID` and any production RTC catalog object IDs in Render instead of the sandbox values.
- Existing users may already have sandbox customer/subscription IDs stored in MongoDB. The backend now keeps sandbox and production IDs separately and will recreate missing production customers when needed.
