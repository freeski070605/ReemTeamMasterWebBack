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
- `BACKEND_URL`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_ENVIRONMENT` (`sandbox` or `production`)
- `SQUARE_LOCATION_ID`
- `SQUARE_WEBHOOK_SECRET`
- `SQUARE_WEBHOOK_SECRETS` (optional comma-separated fallback list when multiple Square subscriptions are active)
- `SQUARE_WEBHOOK_NOTIFICATION_URL` (optional override; defaults to `${BACKEND_URL}/api/webhook/square-webhook`; `/api/webhooks/square` is also supported)
- `MIN_WITHDRAWAL_AMOUNT`

## Square RTC purchase flow

- Frontend calls `POST /api/payment/create-rtc-checkout` with a configured `bundleId`.
- Backend creates a Square payment link with RTC metadata (`purchaseType=rtc_bundle`, `bundleId`, `userId`).
- If you already created Square catalog products/variations, set `squareCatalogObjectId` on each RTC bundle in `src/config/economy.ts` to attach that catalog item to the checkout line item.
- Square sends webhook events (for example `payment.updated`) to `/api/webhooks/square` (or legacy `/api/webhook/square-webhook`).
- Backend verifies the webhook signature and credits RTC only after a completed payment.
