import app from './app';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import connectDB from './config/db';
import { connectRedis } from './config/redis';
import setupSocketHandlers from './sockets'; // Import the socket handlers
import dotenv from 'dotenv';
import { socketCorsOptions } from './config/cors';

dotenv.config();

const PORT = process.env.PORT || 5000;
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: socketCorsOptions,
});

// Setup Socket.IO event handlers
setupSocketHandlers(io);

const startServer = async () => {
  try {
    // Connect to MongoDB
    await connectDB();

    // Connect to Redis
    await connectRedis();

    // Start the Express server
    httpServer.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`API Documentation: http://localhost:${PORT}/api-docs`); // Placeholder for future Swagger/OpenAPI docs
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();
