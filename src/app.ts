import express from 'express';
import cors from 'cors';
import authRoutes from './routes/authRoutes'; // Import auth routes
import paymentRoutes from './routes/paymentRoutes'; // Import payment routes
import webhookRoutes from './routes/webhookRoutes'; // Import webhook routes
import walletRoutes from './routes/walletRoutes'; // Import wallet routes
import tableRoutes from './routes/tableRoutes'; // Import table routes
import userRoutes from './routes/userRoutes'; // Import user routes
import authMiddleware from './middleware/auth'; // Import auth middleware
import passport from 'passport';
import './config/passport'; // Import passport config
import { corsOptions } from './config/cors';

const app = express();

// Middleware
app.use(cors(corsOptions));
app.use(passport.initialize());
// IMPORTANT: Square webhooks send raw body, so we need a conditional body parser
app.use((req, res, next) => {
  if (req.originalUrl === '/api/webhook/square-webhook') {
    next(); // Skip express.json() for Square webhooks
  } else {
    express.json()(req, res, next);
  }
});
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded

// Basic Route
app.get('/', (req, res) => {
  res.send('ReemTeam Backend API is running!');
});

// Auth routes
app.use('/api/auth', authRoutes);
app.use('/api/payment', paymentRoutes); // Use payment routes
app.use('/api/webhook', webhookRoutes); // Use webhook routes
app.use('/api/wallet', walletRoutes); // Use wallet routes
app.use('/api/tables', tableRoutes); // Use table routes
app.use('/api/users', userRoutes); // Use user routes

// Protected route example
app.get('/api/protected', authMiddleware, (req, res) => {
  res.json({ message: 'Welcome to a protected route!', user: req.user });
});

export default app;
