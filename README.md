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
- `MIN_WITHDRAWAL_AMOUNT`
