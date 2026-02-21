import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Table from '../models/Table';
import connectDB from '../config/db';
import { GameMode } from '../domain/gameMode';

dotenv.config();

const predefinedTables = [
  { name: "Table A", stake: 1, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table B", stake: 1, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table C", stake: 5, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table D", stake: 5, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table E", stake: 10, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table F", stake: 10, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table G", stake: 25, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table H", stake: 25, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table I", stake: 50, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
  { name: "Table J", stake: 50, mode: GameMode.FREE_RTC_TABLE, minPlayers: 2, maxPlayers: 4, currentPlayerCount: 0, status: "waiting", players: [] },
];

const seedTables = async () => {
  await connectDB();

  try {
    console.log("Seeding tables...");
    await Table.deleteMany({}); // Clear existing tables
    await Table.insertMany(predefinedTables);
    console.log("Tables seeded successfully!");
  } catch (error) {
    console.error("Error seeding tables:", error);
  } finally {
    await mongoose.disconnect();
  }
};

seedTables();
