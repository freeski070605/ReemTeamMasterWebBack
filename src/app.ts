import express from 'express';
import cors from 'cors';
import path from 'path';
import authRoutes from './routes/authRoutes'; // Import auth routes
import paymentRoutes from './routes/paymentRoutes'; // Import payment routes
import webhookRoutes from './routes/webhookRoutes'; // Import webhook routes
import walletRoutes from './routes/walletRoutes'; // Import wallet routes
import tableRoutes from './routes/tableRoutes'; // Import table routes
import userRoutes from './routes/userRoutes'; // Import user routes
import rtcRoutes from './routes/rtcRoutes';
import contestRoutes from './routes/contestRoutes';
import ticketRoutes from './routes/ticketRoutes';
import adminRoutes from './routes/adminRoutes';
import analyticsRoutes from './routes/analyticsRoutes';
import inviteRoutes from './routes/inviteRoutes';
import lobbyRoutes from './routes/lobbyRoutes';
import vipRoutes from './routes/vipRoutes';
import rgeRoutes from './routes/rgeRoutes';
import homeRoutes from './routes/homeRoutes';
import authMiddleware from './middleware/auth'; // Import auth middleware
import { corsOptions } from './config/cors';

const app = express();
app.set('trust proxy', true);

// Middleware
app.use(cors(corsOptions));
app.use('/api/webhook/square-webhook', express.raw({ type: 'application/json' }));
app.use('/api/webhook/square', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/square-webhook', express.raw({ type: 'application/json' }));
app.use('/api/webhooks/square', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded
app.use('/avatars', express.static(path.resolve(__dirname, '../public/avatars')));

// Basic Route
app.get('/', (req, res) => {
  res.send('ReemTeam Backend API is running!');
});

// Auth routes
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes); // Use payment routes
app.use('/api/webhook', webhookRoutes); // Use webhook routes
app.use('/api/webhooks', webhookRoutes); // Square dashboard compatibility alias
app.use('/api/wallet', walletRoutes); // Use wallet routes
app.use('/api/tables', tableRoutes); // Use table routes
app.use('/api/users', userRoutes); // Use user routes
app.use('/api/rtc', rtcRoutes);
app.use('/api/contests', contestRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/invites', inviteRoutes);
app.use('/api/lobby', lobbyRoutes);
app.use('/api/vip', vipRoutes);
app.use('/api/rge', rgeRoutes);
app.use('/api/home', homeRoutes);

// Protected route example
app.get('/api/protected', authMiddleware, (req, res) => {
  res.json({ message: 'Welcome to a protected route!', user: req.user });
});

export default app;
