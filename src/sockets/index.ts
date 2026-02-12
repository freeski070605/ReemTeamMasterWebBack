import { Server, Socket } from "socket.io";
import { initializeGame, loadGameState, saveGameState, playerDrawCard, playerDiscardCard, playerSpreadCards, playerHitSpread, playerDrop, nextTurn, checkReem, IGameState } from "../game/gameEngine";
import { getAIPlayerAction } from "../game/aiPlayer"; // Import AI logic
import Table, { TableDocument } from "../models/Table"; // Import TableDocument
import User from "../models/User";
import Wallet from "../models/Wallet";
import { Card } from "../game/deck";
import { redisClient } from "../config/redis"; // Import redisClient
import mongoose, { Document } from "mongoose"; // Import mongoose and Document

// Define a type for our socket with custom properties
interface CustomSocket extends Socket {
  userId?: string; // Or the actual user ID type from your User schema
  username?: string;
  tableId?: string; // The table the player is currently in
}

const emitWalletBalanceUpdates = async (io: Server, tableId: string, gameState: IGameState) => {
  try {
    const humanPlayers = gameState.players.filter(player => !player.isAI);
    if (humanPlayers.length === 0) return;

    const balances = await Promise.all(
      humanPlayers.map(async (player) => {
        const wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(player.userId) });
        return { userId: player.userId, balance: wallet?.availableBalance ?? 0 };
      })
    );

    for (const update of balances) {
      io.to(tableId).emit("walletBalanceUpdate", update);
    }
  } catch (error) {
    console.error("Failed to emit wallet balance updates:", error);
  }
};

const buildPlayersWithUsernames = async (
  table: TableDocument,
  tableId: string
): Promise<Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>> => {
  const redisPlayers = await redisClient.hGetAll(`table:${tableId}:players`);
  const players: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }> = [];
  const missingHumanIds: string[] = [];

  for (const player of table.players) {
    const userId = player.userId.toString();
    const redisEntry = redisPlayers[userId];
    if (redisEntry) {
      try {
        const data = JSON.parse(redisEntry);
        players.push({
          userId,
          username: data.username || `Player ${userId.substring(0, 4)}`,
          isAI: player.isAI,
          avatarUrl: data.avatarUrl,
        });
        continue;
      } catch {
        // fall through to DB lookup/fallback
      }
    }

    if (!player.isAI) {
      missingHumanIds.push(userId);
    }

    players.push({
      userId,
      username: "",
      isAI: player.isAI,
      avatarUrl: undefined,
    });
  }

  if (missingHumanIds.length > 0) {
    const users = await User.find({
      _id: { $in: missingHumanIds.map(id => new mongoose.Types.ObjectId(id)) },
    }).select("username avatarUrl");
    const userMap = new Map(users.map(u => [u._id.toString(), { username: u.username, avatarUrl: u.avatarUrl }]));

    for (const player of players) {
      if (!player.username && !player.isAI) {
        player.username = userMap.get(player.userId)?.username ?? `Player ${player.userId.substring(0, 4)}`;
      }
      if (!player.avatarUrl && !player.isAI) {
        player.avatarUrl = userMap.get(player.userId)?.avatarUrl;
      }
    }
  }

  for (const player of players) {
    if (!player.username) {
      player.username = player.isAI
        ? `AI_${player.userId.substring(0, 4)}`
        : `Player ${player.userId.substring(0, 4)}`;
    }
  }

  return players;
};

// Helper to add AI players
const addAIPlayers = async (table: TableDocument, currentPlayers: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>): Promise<Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>> => {
  const updatedPlayers = [...currentPlayers];
  const numAIPlayersToAdd = table.maxPlayers - currentPlayers.length;

  for (let i = 0; i < numAIPlayersToAdd; i++) {
    const aiUserId = new mongoose.Types.ObjectId().toString(); // Generate unique ID for AI
    const aiUsername = `AI_Player_${Math.random().toString(36).substring(7)}`;
    updatedPlayers.push({ userId: aiUserId, username: aiUsername, isAI: true });
    
    // Add AI player to table in MongoDB (optional, can be done once at game start for persistence)
    table.players.push({ userId: new mongoose.Types.ObjectId(aiUserId), isAI: true } as any);
    table.currentPlayerCount++;
  }
  await table.save();
  return updatedPlayers;
};

// Helper to handle round transition and AI removal
const handleRoundTransition = async (io: Server, tableId: string) => {
  setTimeout(async () => {
    try {
      let table = await Table.findById(tableId);
      if (!table) return;
      const previousGameState = await loadGameState(tableId);

      const leavingPlayerIds = await redisClient.sMembers(`table:${tableId}:players:leaving`);
      for (const userId of leavingPlayerIds) {
        const leavingPlayer = previousGameState?.players.find((player) => player.userId === userId);
        const fallbackUsername = `Player ${userId.substring(0, 4)}`;
        await handlePlayerLeave(
          io,
          tableId,
          userId,
          leavingPlayer?.username ?? fallbackUsername
        );
      }
      await redisClient.del(`table:${tableId}:players:leaving`);

      table = await Table.findById(tableId);
      if (!table) return;
      if (table.currentPlayerCount < table.minPlayers || table.players.length === 0) {
        table.status = "waiting";
        table.currentMatchId = undefined;
        await table.save();
        io.to(tableId).emit("tableUpdate", { message: "Waiting for players to start the next round.", table });
        return;
      }

      // Rebuild players from table order so dealer rotation remains clockwise and stable.
      let playersWithDetails = await buildPlayersWithUsernames(table, tableId);

      // Filter: Humans vs AIs
      const humans = playersWithDetails.filter(p => !p.isAI);
      const ais = playersWithDetails.filter(p => p.isAI);

      let nextGamePlayers = [...playersWithDetails];

      // If we have enough humans to replace AI
      // And we actually HAVE AIs to remove (otherwise no need to change anything)
      if (humans.length >= table.minPlayers && ais.length > 0) {
          // Keep only humans
          nextGamePlayers = humans;
          
          // Update MongoDB
          // Note: table.players schema has userId and isAI.
          table.players = humans.map(h => ({ userId: new mongoose.Types.ObjectId(h.userId), isAI: false })) as any;
          table.currentPlayerCount = humans.length;
          
          // Remove AIs from Redis
          for (const ai of ais) {
             await redisClient.hDel(`table:${tableId}:players`, ai.userId);
          }
          await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());
          await table.save();
      }

      // Start new game
      const nextDealerIndex = previousGameState
        ? (previousGameState.currentDealerIndex + 1) % Math.max(1, nextGamePlayers.length)
        : 0;

      const newGameState = await initializeGame(table, nextGamePlayers, { dealerIndex: nextDealerIndex });
      await saveGameState(newGameState);
      
      io.to(tableId).emit("tableUpdate", { message: "Starting new round...", table, gameState: newGameState });
      io.to(tableId).emit("initialGameState", newGameState);
      if (newGameState.players[newGameState.currentPlayerIndex]?.isAI) {
        handleAITurn(io, tableId);
      }

    } catch (e) {
      console.error("Error in round transition:", e);
    }
  }, 30000); // 30 second delay
};

// Helper to handle AI turns
const handleAITurn = async (io: Server, tableId: string) => {
  try {
    let gameState = await loadGameState(tableId);
    if (!gameState) return;

    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (!currentPlayer || !currentPlayer.isAI) return;

    console.log(`[AI] Starting turn for ${currentPlayer.username} (${currentPlayer.userId})`);

    // Small delay for realism
    setTimeout(async () => {
      // Reload state in case something changed
      gameState = await loadGameState(tableId);
      if (!gameState) return;

      // Double check it's still AI turn
      const currentNow = gameState.players[gameState.currentPlayerIndex];
      if (currentNow.userId !== currentPlayer.userId) return;

      try {
        const aiAction = getAIPlayerAction(gameState, currentPlayer.userId);
        console.log(`[AI] ${currentPlayer.username} chose action: ${aiAction.type}`);

        let updatedGameState = gameState;
        let turnEnded = false;

        if (aiAction.type === 'draw') {
           updatedGameState = await playerDrawCard(updatedGameState, currentPlayer.userId);
           await saveGameState(updatedGameState);
           io.to(tableId).emit("gameStateUpdate", updatedGameState);

           if (updatedGameState.status === 'round-end') {
              await emitWalletBalanceUpdates(io, tableId, updatedGameState);
              handleRoundTransition(io, tableId);
              return;
           }
           
           // AI continues turn after drawing
           handleAITurn(io, tableId);
           return;

        } else if (aiAction.type === 'discard') {
           if (aiAction.payload?.card) {
               updatedGameState = await playerDiscardCard(updatedGameState, currentPlayer.userId, aiAction.payload.card);
               await saveGameState(updatedGameState);
               io.to(tableId).emit("gameStateUpdate", updatedGameState);

               if (updatedGameState.status === 'round-end') {
                  await emitWalletBalanceUpdates(io, tableId, updatedGameState);
                  handleRoundTransition(io, tableId);
                  return;
               }
               
               console.log(`[DEBUG] AI Discard success. Moving to next turn.`);
               const nextGameState = nextTurn(updatedGameState);
               await saveGameState(nextGameState);
               io.to(tableId).emit("gameStateUpdate", nextGameState);
               turnEnded = true;
           }
        } else if (aiAction.type === 'spread') {
             if (aiAction.payload?.cards) {
               updatedGameState = await playerSpreadCards(updatedGameState, currentPlayer.userId, aiAction.payload.cards);
               if (updatedGameState.status === 'round-end') {
                   await saveGameState(updatedGameState);
                   io.to(tableId).emit("gameStateUpdate", updatedGameState);
                   await emitWalletBalanceUpdates(io, tableId, updatedGameState);
                   handleRoundTransition(io, tableId);
                   return;
               }
               await saveGameState(updatedGameState);
               io.to(tableId).emit("gameStateUpdate", updatedGameState);
               // AI continues turn
               handleAITurn(io, tableId);
               return;
             }
        } else if (aiAction.type === 'drop') {
            updatedGameState = await playerDrop(updatedGameState, currentPlayer.userId);
            await saveGameState(updatedGameState);
            io.to(tableId).emit("gameStateUpdate", updatedGameState);
            await emitWalletBalanceUpdates(io, tableId, updatedGameState);
            handleRoundTransition(io, tableId);
            return;
        }

        if (turnEnded) {
            // Check if NEXT player is AI
            const nextGameState = await loadGameState(tableId);
            if (nextGameState) {
                const nextPlayer = nextGameState.players[nextGameState.currentPlayerIndex];
                if (nextPlayer.isAI) {
                    handleAITurn(io, tableId);
                }
            }
        }

      } catch (e) {
          console.error("Error in AI turn:", e);
      }
    }, 1000);
  } catch (err) {
      console.error("Error setting up AI turn:", err);
  }
};

const handlePlayerLeave = async (io: Server, tableId: string, userId: string, username: string) => {
  const lockKey = `lock:table:${tableId}`;
  const lockAcquired = await redisClient.set(lockKey, "locked", {
    NX: true,
    EX: 10,
  }); // Lock for 10s

  if (!lockAcquired) {
    console.log(`[RACE_FIX] Lock already held for table ${tableId}. Skipping leave logic.`);
    return;
  }

  try {
    console.log(`[RACE_FIX] Handling player leave for ${username} (${userId}) from table ${tableId}`);
    
    // Atomically update the table to remove the player
    const table = await Table.findByIdAndUpdate(
      tableId,
      {
        $pull: { players: { userId: new mongoose.Types.ObjectId(userId) } },
        $inc: { currentPlayerCount: -1 },
      },
      { new: true } // Return the updated document
    );

    if (!table) {
      console.log(`[RACE_FIX] Table ${tableId} not found during leave process.`);
      return;
    }

    // Update Redis for table occupancy
    await redisClient.hDel(`table:${tableId}:players`, userId);
    await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

    // Check if no humans left
    const humansLeft = table.players.filter(p => !p.isAI);

    if (humansLeft.length === 0) {
      // No humans left, fully reset the table
      console.log(`Table ${tableId} is empty of humans. Resetting table state.`);
      table.players = [];
      table.currentPlayerCount = 0;
      table.status = "waiting";
      table.currentMatchId = undefined;
      await table.save();

      // Clear all Redis data for this table
      await redisClient.del(`table:${tableId}:players`);
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", "0");
      await redisClient.del(`game:${tableId}`);

    } else if (table.currentPlayerCount < table.minPlayers && table.status === "in-game") {
      // If game was in progress and now not enough human players (but some humans remain)
      // Remove AI players and set to waiting
      table.players = table.players.filter(p => !p.isAI) as any;
      table.currentPlayerCount = table.players.length;
      table.status = "waiting"; // Set to waiting if not enough players
      table.currentMatchId = undefined; // Clear current match if game ends
      await table.save();

      // Remove AI players from Redis occupancy
      const allRedisPlayers = await redisClient.hGetAll(`table:${tableId}:players`);
      for (const playerId in allRedisPlayers) {
        const playerInfo = JSON.parse(allRedisPlayers[playerId]);
        if (playerInfo.isAI) {
          await redisClient.hDel(`table:${tableId}:players`, playerId);
        }
      }
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

      let gameState = await loadGameState(tableId);
      if (gameState) {
        // Remove AIs from game state
        gameState.players = gameState.players.filter(p => !p.isAI && p.userId !== userId);
        await saveGameState(gameState);
      }
      io.to(tableId).emit("tableUpdate", { message: `${username} left, game reset due to insufficient players.`, table, gameState });

    } else {
      // If game is still in-game and has enough players (potentially with AI remaining)
      // Or if it was already waiting, just update the table.
      let gameState = await loadGameState(tableId);
      if (gameState) {
        gameState.players = gameState.players.filter(p => p.userId !== userId); // Remove only the human player from game state
        await saveGameState(gameState);
        io.to(tableId).emit("tableUpdate", { message: `${username} left the table.`, table, gameState });
      }
    }

    io.to(tableId).emit("playerLeft", { userId });
  } finally {
    await redisClient.del(lockKey);
  }
};


// Centralized event handler setup
const setupSocketHandlers = (io: Server) => {
  io.on("connection", (socket: CustomSocket) => {
    console.log(`User connected: ${socket.id}`);

    // Event: Player joins a table
    socket.on("joinTable", async ({ tableId, userId, username, avatarUrl }: { tableId: string; userId: string; username: string; avatarUrl?: string }) => {
      console.log(`User ${username} (${userId}) attempting to join table ${tableId}`);
      let table = await Table.findById(tableId);
      if (!table) {
        return socket.emit("gameError", { message: "Table not found." });
      }

      if (table.currentPlayerCount >= table.maxPlayers) {
        return socket.emit("gameError", { message: "Table is full." });
      }

      // Validate player's balance
      const wallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(userId) });
      if (!wallet || wallet.availableBalance < table.stake * 4) {
        return socket.emit("gameError", { message: "Insufficient funds to join this table." });
      }

      // Check if player is already in the table
      const existingPlayer = table.players.find(p => p.userId.toString() === userId);
      if (existingPlayer) {
        console.log(`User ${username} (${userId}) is already in table ${tableId}. Rejoining.`);
        socket.join(tableId);
        socket.tableId = tableId;
        socket.userId = userId;
        socket.username = username;

        const gameState = await loadGameState(tableId);
        if (gameState) {
          if (gameState.players[gameState.currentPlayerIndex]?.isAI) {
            handleAITurn(io, tableId);
          }
          return io.to(socket.id).emit("initialGameState", gameState); // Send existing state
        } else {
          return socket.emit("gameError", { message: "No active game state found for this table." });
        }
      }

      // Add player to table in MongoDB
      table.players.push({ userId: new mongoose.Types.ObjectId(userId), isAI: false } as any);
      table.currentPlayerCount++;
      // Update Redis for table occupancy
      await redisClient.hSet(`table:${tableId}:players`, userId, JSON.stringify({ username, isAI: false, avatarUrl: avatarUrl ?? null }));
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

      // Join the socket room immediately so the player receives updates even if the game starts immediately
      socket.join(tableId);
      console.log(`Socket ${socket.id} explicitly joined room ${tableId} (Pre-game check)`);
      socket.tableId = tableId;
      socket.userId = userId;
      socket.username = username;
      
      // Check if we need to add an AI to start the game immediately (1 User vs 1 AI)
      if (table.currentPlayerCount === 1) {
          console.log(`Only 1 player in table ${tableId}, adding an AI opponent.`);
          const aiUserId = new mongoose.Types.ObjectId().toString();
          const aiUsername = `Bot_${Math.random().toString(36).substring(2, 6)}`;
          
          // Add to MongoDB
          table.players.push({ userId: new mongoose.Types.ObjectId(aiUserId), isAI: true } as any);
          table.currentPlayerCount++;
          
          // Add to Redis
          await redisClient.hSet(`table:${tableId}:players`, aiUserId, JSON.stringify({ username: aiUsername, isAI: true, avatarUrl: null }));
          await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

          // Update local players list
      }

      let playersInTable = await buildPlayersWithUsernames(table, tableId);

      // Add AI players if not enough human players to start a game
      if (table.currentPlayerCount < table.minPlayers) {
        // If not enough human players, wait for more or add AI if a game needs to start.
        // For now, let's delay AI addition until we hit minPlayers
      }
      
      if (table.currentPlayerCount >= table.minPlayers && table.status === "waiting") {
        table.status = "in-game"; // Set table status to in-game
        // REMOVED: playersInTable = await addAIPlayers(table, playersInTable); // No longer auto-filling with AI
        
        // Update Redis for any existing AI players (like the one added for 1v1)
        for(const player of playersInTable) {
          if (player.isAI) {
             // Check if already in redis? hSet overwrites so it's fine, but we only really need to add the new 1v1 AI if it wasn't there.
             // The 1v1 AI was added to Redis in the block above (lines 143), so we might not need this loop if we don't add more AIs.
             // However, for safety/consistency, we can ensure they are in Redis.
             await redisClient.hSet(`table:${tableId}:players`, player.userId, JSON.stringify({ username: player.username, isAI: true, avatarUrl: null }));
          }
        }
        // table.currentPlayerCount is already updated if we added the 1v1 AI.
        await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

        let gameState = await initializeGame(table, playersInTable);
        await saveGameState(gameState);
        table.currentMatchId = new mongoose.Types.ObjectId(); // Create a new Match ID for the table
        await table.save();
        io.to(tableId).emit("tableUpdate", { message: `${username} joined, game starting with AI.`, table, gameState });
        io.to(socket.id).emit("initialGameState", gameState);
        if (gameState.players[gameState.currentPlayerIndex]?.isAI) {
          handleAITurn(io, tableId);
        }
        return; // Exit after starting game
      }

      await table.save();

      console.log(`User ${username} (${userId}) joined table ${tableId}. Current players: ${table.currentPlayerCount}`);

      let gameState: IGameState | null = await loadGameState(tableId);
      if (!gameState) {
        // This block should ideally not be reached if game starts above, but as a fallback
        // In a real scenario, this would mean starting a game with initial human players, awaiting more.
        const playersForNewGame = await buildPlayersWithUsernames(table, tableId);
        gameState = await initializeGame(table, playersForNewGame);
        // if (gameState) { // Already checked by next if block
        await saveGameState(gameState);
        // }
        table.currentMatchId = undefined; // No match ID until game starts properly
        await table.save();
      }

      io.to(tableId).emit("tableUpdate", { message: `${username} joined the table.`, table, gameState });
      io.to(socket.id).emit("initialGameState", gameState);
      if (gameState.players[gameState.currentPlayerIndex]?.isAI) {
        handleAITurn(io, tableId);
      }
    });

    // Event: Player leaves a table (or disconnects)
    socket.on("leaveTable", async ({ tableId, userId, username }: { tableId: string; userId: string; username: string }) => {
      console.log(`[leaveTable] User ${username} (${userId}) leaving table ${tableId}`);
      
      const gameState = await loadGameState(tableId);
      if (gameState && gameState.status === 'in-progress') {
        console.log(`Player ${userId} will leave table ${tableId} after the round.`);
        await redisClient.sAdd(`table:${tableId}:players:leaving`, userId);
        socket.emit("ackLeaveRequest");
        return;
      }
      
      socket.leave(tableId);
      
      // Clear socket association to prevent disconnect handler from running the same logic
      const leavingTableId = socket.tableId;
      socket.tableId = undefined;
      
      if (leavingTableId) {
          await handlePlayerLeave(io, leavingTableId, userId, username);
      }
    });

    socket.on("requestLeaveTable", async ({ tableId, userId }: { tableId: string; userId: string }) => {
      console.log(`Player ${userId} wants to leave table ${tableId} after the round.`);
      await redisClient.sAdd(`table:${tableId}:players:leaving`, userId);
      socket.emit("ackLeaveRequest");
    });

    // Event: Player draws a card
    socket.on("drawCard", async ({ tableId, userId, source }: { tableId: string; userId: string; source: 'deck' | 'discard' }) => {
      console.log(`User ${userId} drew a card from ${source} in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerDrawCard(gameState, userId, source);
          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);

          if (updatedGameState.status === "round-end") {
             await emitWalletBalanceUpdates(io, tableId, updatedGameState);
             console.log(`Round ended (Deck Empty) in table ${tableId}`);
             handleRoundTransition(io, tableId);
             return;
          }

        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Player discards a card
    socket.on("discardCard", async ({ tableId, userId, card }: { tableId: string; userId: string; card: Card }) => {
      console.log(`User ${userId} discarded ${card.rank} of ${card.suit} in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerDiscardCard(gameState, userId, card);
          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);

          if (updatedGameState.status === "round-end") {
            await emitWalletBalanceUpdates(io, tableId, updatedGameState);
            handleRoundTransition(io, tableId);
            return;
          }
          
          // After discarding, it\'s usually the next player\'s turn
          const nextGameState = nextTurn(updatedGameState);
          
          await saveGameState(nextGameState);
          io.to(tableId).emit("gameStateUpdate", nextGameState);

          // Check if next player is AI
          if (nextGameState.players[nextGameState.currentPlayerIndex].isAI) {
              handleAITurn(io, tableId);
          }
        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Player spreads cards
    socket.on("spread", async ({ tableId, userId, cards }: { tableId: string; userId: string; cards: Card[] }) => {
      console.log(`User ${userId} spread cards ${cards.map(c => c.rank).join(", ")} in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerSpreadCards(gameState, userId, cards);
          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          if (updatedGameState.status === "round-end") {
            // Handle Reem case - round ends instantly
            console.log(`Player ${userId} Reemed! Round ends.`);
            await emitWalletBalanceUpdates(io, tableId, updatedGameState);
            handleRoundTransition(io, tableId);
          } else {
            // If not Reem, proceed to discard or next turn logic
            // For Tonk, usually after spreading, you must discard one card.
            // This logic will be more complex and managed by turn flow.
          }
        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Player hits a spread
    socket.on("hit", async ({ tableId, userId, card, targetPlayerId, targetSpreadIndex }: { tableId: string; userId: string; card: Card; targetPlayerId: string; targetSpreadIndex: number }) => {
      console.log(`User ${userId} hit spread of ${targetPlayerId} with ${card.rank} in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerHitSpread(gameState, userId, card, targetPlayerId, targetSpreadIndex);
          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          // After hitting, the player must discard one card.
          // This logic will be more complex and managed by turn flow.
        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Player drops
    socket.on("drop", async ({ tableId, userId }: { tableId: string; userId: string }) => {
      console.log(`User ${userId} dropped in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerDrop(gameState, userId);
          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          // Round ends after a drop. Payouts will be calculated.
          console.log(`Player ${userId} dropped. Round ends.`);
          await emitWalletBalanceUpdates(io, tableId, updatedGameState);
          handleRoundTransition(io, tableId);
        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Client requests initial game state (for new connections or reloads)
    socket.on("requestInitialGameState", async ({ tableId }: { tableId: string }) => {
      console.log(`User ${socket.id} requested initial game state for table ${tableId}`);
      const gameState = await loadGameState(tableId);
      if (gameState) {
        socket.emit("initialGameState", gameState);
      } else {
        socket.emit("gameError", { message: "No active game state found for this table." });
      }
    });

    // Generic game action event for flexibility (can be refined later)
    socket.on("gameAction", async ({ tableId, actionType, payload }: { tableId: string; actionType: string; payload: any }) => {
      console.log(`Generic game action received: ${actionType} from ${socket.id} in table ${tableId} with payload:`, payload);
      // A more robust game engine would centralize action dispatch here
      // For now, direct event handlers are used for specific actions.
      // io.to(tableId).emit("gameStateUpdate", { /* updated game state */ });
    });

    socket.on("disconnect", async () => {
      console.log(`[disconnect] User disconnected: ${socket.id}`);
      if (socket.tableId && socket.userId && socket.username) {
        await handlePlayerLeave(io, socket.tableId, socket.userId, socket.username);
      }
    });
  });
};

export default setupSocketHandlers;
