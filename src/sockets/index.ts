import { Server, Socket } from "socket.io";
import { initializeGame, loadGameState, saveGameState, playerDrawCard, playerDiscardCard, playerSpreadCards, playerHitSpread, playerDrop, playerDeclare41, findFirstMandatorySpread, nextTurn, IGameState, toEngineRoundResult, DEFAULT_TURN_DURATION_MS, calculateHandValue } from "../game/gameEngine";
import { getAIPlayerAction } from "../game/aiPlayer"; // Import AI logic
import Table, { TableDocument } from "../models/Table"; // Import TableDocument
import Contest, { ContestDocument } from "../models/Contest";
import User from "../models/User";
import { Card } from "../game/deck";
import { resolveStakeAmountForMode } from "../config/economy";
import { redisClient } from "../config/redis"; // Import redisClient
import mongoose from "mongoose";
import { GameMode } from "../domain/gameMode";
import { ModeController } from "../services/modeController";
import { ContestService } from "../services/contestService";
import { ensureWalletForUser } from "../services/walletProvisioningService";
import Invite from "../models/Invite";
import { PresenceService } from "../services/presenceService";
import { RecentPlayerService } from "../services/recentPlayerService";
import { resolveUserRole, roleAtLeast } from "../constants/roles";
import { getAiAvatarUrl, getPromoAiProfile } from "../constants/promoAi";

// Define a type for our socket with custom properties
interface CustomSocket extends Socket {
  userId?: string; // Or the actual user ID type from your User schema
  username?: string;
  tableId?: string; // The table the player is currently in
  spectatorTableId?: string;
  isSpectator?: boolean;
}

const ROUND_READY_DURATION_MS = 30000;
const PROMO_ROUND_READY_DURATION_MS = 20000;
const TURN_DURATION_MS = DEFAULT_TURN_DURATION_MS;
const PROMO_AI_COUNT = 4;
const roundTransitionTimers = new Map<string, NodeJS.Timeout>();
const turnExpiryTimers = new Map<string, NodeJS.Timeout>();
const roundCurrency = (value: number): number => Math.round(value * 100) / 100;
const LOBBY_ROOM = "lobby";
let lastPresenceBroadcastAt = 0;
let lastLobbyOnlineCount: number | null = null;
let lastLobbyConnectionCount: number | null = null;

const getPromoAiIdentity = (index: number) => {
  const profile = getPromoAiProfile(index);
  return {
    username: profile.username,
    avatarUrl: profile.avatarUrl,
  };
};

const getStandardAiIdentity = (userId: string, username: string) => ({
  username,
  avatarUrl: getAiAvatarUrl(userId),
});

const getLobbyConnectionCount = (io: Server) => {
  return io.sockets.adapter.rooms.get(LOBBY_ROOM)?.size ?? 0;
};

const emitLobbyPresence = async (io: Server, force = false) => {
  const now = Date.now();
  if (!force && now - lastPresenceBroadcastAt < 4000) {
    return;
  }

  const onlinePlayers = await PresenceService.getOnlineCount();
  const lobbyConnections = getLobbyConnectionCount(io);

  if (
    !force &&
    lastLobbyOnlineCount === onlinePlayers &&
    lastLobbyConnectionCount === lobbyConnections
  ) {
    return;
  }

  lastPresenceBroadcastAt = now;
  lastLobbyOnlineCount = onlinePlayers;
  lastLobbyConnectionCount = lobbyConnections;

  io.to(LOBBY_ROOM).emit("lobbyPresence", {
    onlinePlayers,
    lobbyConnections,
    timestamp: now,
  });
};

const emitLobbyEvent = (
  io: Server,
  payload: { type: string; message: string; tableId?: string; username?: string }
) => {
  io.to(LOBBY_ROOM).emit("lobbyEvent", {
    ...payload,
    timestamp: Date.now(),
  });
};

const clearTurnExpiryTimer = (tableId: string) => {
  const timer = turnExpiryTimers.get(tableId);
  if (!timer) return;
  clearTimeout(timer);
  turnExpiryTimers.delete(tableId);
};

const resolveTurnDurationMs = (gameState: IGameState): number => {
  return gameState.turnDurationMs ?? TURN_DURATION_MS;
};

const resolveTurnExpiresAt = (gameState: IGameState): number => {
  const durationMs = resolveTurnDurationMs(gameState);
  if (typeof gameState.turnExpiresAt === "number") {
    return gameState.turnExpiresAt;
  }
  const startTime = gameState.turnStartTime ?? Date.now();
  return startTime + durationMs;
};

const resolveBalanceForMode = (wallet: any | null, mode?: GameMode): number => {
  if (!wallet) return 0;
  if (mode === GameMode.USD_CONTEST) {
    return wallet.usdBalance ?? wallet.availableBalance ?? 0;
  }
  return wallet.rtcBalance ?? 0;
};

const isContinuousMode = (mode?: GameMode): boolean => {
  return mode === GameMode.FREE_RTC_TABLE || mode === undefined;
};

const isCribTableMode = (mode?: GameMode): boolean => {
  return mode === GameMode.FREE_RTC_TABLE || mode === undefined;
};

const isCompetitionMode = (mode?: GameMode): boolean => {
  return mode === GameMode.RTC_TOURNAMENT || mode === GameMode.RTC_SATELLITE || mode === GameMode.USD_CONTEST;
};

const findContestByAnyId = async (contestId: string): Promise<ContestDocument | null> => {
  const byContestId = await Contest.findOne({ contestId });
  if (byContestId) {
    return byContestId;
  }

  if (mongoose.Types.ObjectId.isValid(contestId)) {
    return Contest.findById(contestId);
  }

  return null;
};

const getContestParticipantIds = (contest: ContestDocument): Set<string> => {
  return new Set(contest.participants.map((participant) => participant.toString()));
};

const bindPlayerToUsdContest = async (
  table: TableDocument,
  userId: string,
  requestedContestId?: string
): Promise<ContestDocument> => {
  const resolvedContestId = requestedContestId?.trim() || table.activeContestId?.trim();
  if (!resolvedContestId) {
    throw new Error("USD_CONTEST tables require a contestId.");
  }

  let contest = await findContestByAnyId(resolvedContestId);
  if (!contest) {
    throw new Error("Contest not found.");
  }

  if (contest.mode !== GameMode.USD_CONTEST) {
    throw new Error("Only USD_CONTEST contest sessions can bind to USD_CONTEST tables.");
  }

  if (roundCurrency(contest.entryFee) !== roundCurrency(table.stake)) {
    throw new Error("Contest entry fee does not match this table stake.");
  }

  if (table.activeContestId && table.activeContestId !== contest.contestId) {
    throw new Error("This table is already bound to a different contest.");
  }

  if (table.currentPlayerCount >= contest.playerCount) {
    throw new Error("This contest table is full.");
  }

  const participantIds = getContestParticipantIds(contest);
  if (!participantIds.has(userId)) {
    if (contest.status !== "open") {
      throw new Error(`Contest is not joinable in status "${contest.status}".`);
    }
    const joinResult = await ContestService.joinContestWithUsd(contest.contestId, userId);
    contest = joinResult.contest;
  }

  if (!getContestParticipantIds(contest).has(userId)) {
    throw new Error("User is not registered in this contest.");
  }

  return contest;
};

const emitWalletBalanceUpdates = async (io: Server, tableId: string, gameState: IGameState) => {
  try {
    const humanPlayers = gameState.players.filter(player => !player.isAI);
    if (humanPlayers.length === 0) return;

    const balances = await Promise.all(
      humanPlayers.map(async (player) => {
        const wallet = await ensureWalletForUser(player.userId);
        return {
          userId: player.userId,
          balance: resolveBalanceForMode(wallet, gameState.mode),
        };
      })
    );

    for (const update of balances) {
      io.to(tableId).emit("walletBalanceUpdate", update);
    }
  } catch (error) {
    console.error("Failed to emit wallet balance updates:", error);
  }
};

const initializeRoundWithEconomy = async (
  table: TableDocument,
  players: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>,
  options?: { dealerIndex?: number },
  adminUserId?: string
): Promise<IGameState> => {
  const initializedState = await initializeGame(table, players, options);
  return ModeController.applyRoundEntryEconomy(initializedState, adminUserId);
};

const settleRoundAndBroadcast = async (
  io: Server,
  tableId: string,
  gameState: IGameState
): Promise<IGameState> => {
  clearTurnExpiryTimer(tableId);
  const settledState = await ModeController.settleRound(gameState);
  await saveGameState(settledState);
  io.to(tableId).emit("gameStateUpdate", settledState);
  const roundResult = toEngineRoundResult(settledState);
  if (roundResult) {
    io.to(tableId).emit("roundResult", roundResult);
  }

  if (settledState.roundSettlementStatus !== 'settled') {
    if (settledState.roundSettlementStatus === 'failed') {
      io.to(tableId).emit("gameError", {
        message: settledState.roundSettlementError ?? "Round settlement failed.",
      });
    }
    return settledState;
  }

  await emitWalletBalanceUpdates(io, tableId, settledState);
  try {
    await RecentPlayerService.recordRecentPlayers(settledState.players);
  } catch (error) {
    console.error("Failed to record recent players:", error);
  }
  if (isContinuousMode(settledState.mode)) {
    await beginRoundReadyPhase(io, tableId, settledState);
    return settledState;
  }

  const table = await Table.findById(tableId);
  if (table) {
    table.status = "waiting";
    table.currentMatchId = undefined;
    if (table.mode === GameMode.USD_CONTEST) {
      table.activeContestId = undefined;
    }
    await table.save();
    await redisClient.del(`table:${tableId}:players:leaving`);
    io.to(tableId).emit("tableUpdate", {
      message: "Competition match complete. Table is now waiting for a new session.",
      table,
      gameState: settledState,
    });
  }

  return settledState;
};

const buildPlayersWithUsernames = async (
  table: TableDocument,
  tableId: string
): Promise<Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>> => {
  const redisPlayers = await redisClient.hGetAll(`table:${tableId}:players`);
  const players: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }> = [];
  const missingHumanIds: string[] = [];

  for (const [index, player] of table.players.entries()) {
    const userId = player.userId.toString();
    const redisEntry = redisPlayers[userId];
    const promoIdentity = table.isPromo && player.isAI ? getPromoAiIdentity(index) : null;
      if (redisEntry) {
        try {
          const data = JSON.parse(redisEntry);
          const standardAiIdentity = !table.isPromo && player.isAI
            ? getStandardAiIdentity(userId, data.username || `AI_${userId.substring(0, 4)}`)
            : null;
          players.push({
            userId,
            username: promoIdentity?.username ?? standardAiIdentity?.username ?? (data.username || `Player ${userId.substring(0, 4)}`),
            isAI: player.isAI,
            avatarUrl: promoIdentity?.avatarUrl ?? standardAiIdentity?.avatarUrl ?? data.avatarUrl,
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
      username: promoIdentity?.username ?? (player.isAI ? getStandardAiIdentity(userId, "").username : ""),
      isAI: player.isAI,
      avatarUrl: promoIdentity?.avatarUrl ?? (player.isAI ? getAiAvatarUrl(userId) : undefined),
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

  for (const [index, player] of players.entries()) {
    if (!player.username) {
      player.username = player.isAI
        ? table.isPromo
          ? getPromoAiIdentity(index).username
          : `AI_${player.userId.substring(0, 4)}`
        : `Player ${player.userId.substring(0, 4)}`;
    }

    if (player.isAI && table.isPromo && !player.avatarUrl) {
      player.avatarUrl = getPromoAiIdentity(index).avatarUrl;
    }

    if (player.isAI && !table.isPromo && !player.avatarUrl) {
      player.avatarUrl = getAiAvatarUrl(player.userId);
    }
  }

  return players;
};

const ensurePromoGameState = async (
  io: Server,
  table: TableDocument,
  spectatorUserId?: string
): Promise<IGameState> => {
  const tableId = table._id.toString();
  const existingState = await loadGameState(tableId);
  if (existingState) {
    let didUpdateExistingState = false;
    existingState.players = existingState.players.map((player, index) => {
      if (!player.isAI) {
        return player;
      }

      const promoIdentity = getPromoAiIdentity(index);
      if (player.username === promoIdentity.username && player.avatarUrl === promoIdentity.avatarUrl) {
        return player;
      }

      didUpdateExistingState = true;
      return {
        ...player,
        username: promoIdentity.username,
        avatarUrl: promoIdentity.avatarUrl,
      };
    });

    if (didUpdateExistingState) {
      await saveGameState(existingState);
    }

    return existingState;
  }

  const allPlayers = await buildPlayersWithUsernames(table, tableId);
  const humanPlayerIds = allPlayers
    .filter((player) => !player.isAI)
    .map((player) => player.userId);

  const adminUserIds = new Set<string>();
  if (humanPlayerIds.length > 0) {
    const humanUsers = await User.find({ _id: { $in: humanPlayerIds } }).select("role isAdmin");
    humanUsers.forEach((user) => {
      if (roleAtLeast(resolveUserRole(user.role, !!user.isAdmin), "admin")) {
        adminUserIds.add(user._id.toString());
      }
    });
  }

  const promoPlayers = allPlayers.filter(
    (player) => player.isAI || adminUserIds.has(player.userId)
  );

  if (promoPlayers.length !== table.players.length) {
    throw new Error("Promo tables are restricted to AI players and admins.");
  }

  if (table.players.length !== PROMO_AI_COUNT) {
    throw new Error(`Promo tables must have exactly ${PROMO_AI_COUNT} players.`);
  }

  table.status = "in-game";
  table.currentPlayerCount = promoPlayers.length;
  table.minPlayers = PROMO_AI_COUNT;
  table.maxPlayers = PROMO_AI_COUNT;
  table.isPrivate = true;
  table.isPromo = true;
  table.currentMatchId = new mongoose.Types.ObjectId();
  await table.save();
  await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", String(promoPlayers.length));

  let gameState = await initializeRoundWithEconomy(table, promoPlayers, undefined, spectatorUserId);
  await saveGameState(gameState);

  if (gameState.status === "round-end") {
    gameState = await settleRoundAndBroadcast(io, tableId, gameState);
  } else {
    io.to(tableId).emit("tableUpdate", {
      message: "Promo table live.",
      table,
      gameState,
    });
  }

  runTurnLoop(io, tableId, gameState);
  return gameState;
};

// Helper to add AI players
const addAIPlayers = async (table: TableDocument, currentPlayers: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>): Promise<Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>> => {
  const updatedPlayers = [...currentPlayers];
  const numAIPlayersToAdd = table.maxPlayers - currentPlayers.length;

  for (let i = 0; i < numAIPlayersToAdd; i++) {
    const aiUserId = new mongoose.Types.ObjectId().toString(); // Generate unique ID for AI
    const aiUsername = `AI_Player_${Math.random().toString(36).substring(7)}`;
    const aiIdentity = getStandardAiIdentity(aiUserId, aiUsername);
    updatedPlayers.push({ userId: aiUserId, username: aiIdentity.username, isAI: true, avatarUrl: aiIdentity.avatarUrl });
    
    // Find an empty seat for the AI
    let aiSeatIndex = -1;
    for (let i = 0; i < table.maxPlayers; i++) {
      const isSeatTaken = table.players.some(p => p?.seat === i);
      if (!isSeatTaken) {
        aiSeatIndex = i;
        break;
      }
    }

    if (aiSeatIndex !== -1) {
        // Add AI player to table in MongoDB (optional, can be done once at game start for persistence)
        table.players.push({ 
            userId: new mongoose.Types.ObjectId(aiUserId), 
            isAI: true,
            seat: aiSeatIndex
        } as any);
        table.currentPlayerCount++;
    }
  }
  table.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  await table.save();
  return updatedPlayers;
};

const clearRoundTransitionTimer = (tableId: string) => {
  const timer = roundTransitionTimers.get(tableId);
  if (timer) {
    clearTimeout(timer);
    roundTransitionTimers.delete(tableId);
  }
};

const allRoundPlayersReady = (gameState: IGameState): boolean => {
  const readySet = new Set(gameState.roundReadyPlayerIds ?? []);
  return gameState.players.every((player) => readySet.has(player.userId));
};

const resolveRoundReadyConfig = async (
  tableId: string
): Promise<{ durationMs: number; isPromo: boolean }> => {
  const table = await Table.findById(tableId).select("isPromo");
  const isPromo = table?.isPromo ?? false;
  return {
    durationMs: isPromo ? PROMO_ROUND_READY_DURATION_MS : ROUND_READY_DURATION_MS,
    isPromo,
  };
};

const scheduleTurnExpiryTimer = (io: Server, tableId: string, gameState: IGameState) => {
  clearTurnExpiryTimer(tableId);

  if (gameState.status !== "in-progress") {
    return;
  }

  const currentPlayer = gameState.players[gameState.currentPlayerIndex];
  if (!currentPlayer) {
    return;
  }

  const turnExpiresAt = resolveTurnExpiresAt(gameState);
  const remainingMs = Math.max(0, turnExpiresAt - Date.now());
  const expectedTurn = gameState.turn;
  const expectedPlayerId = currentPlayer.userId;

  const timer = setTimeout(() => {
    void handleTurnExpiration(io, tableId, expectedTurn, expectedPlayerId);
  }, remainingMs);

  turnExpiryTimers.set(tableId, timer);
};

const canAutoDeclare41 = (player: IGameState["players"][number] | undefined): boolean => {
  if (!player) {
    return false;
  }

  const hasDrawnThisTurn = player.hasDrawnThisTurn ?? !!player.hasTakenActionThisTurn;
  const hasDiscardedThisTurn = player.hasDiscardedThisTurn ?? false;

  return (
    !hasDrawnThisTurn &&
    !hasDiscardedThisTurn &&
    !player.hasDrawnAnyCard &&
    player.startingHandValue === 41 &&
    calculateHandValue(player.hand) === 41
  );
};

const runTurnLoop = (io: Server, tableId: string, gameState: IGameState) => {
  if (gameState.status !== "in-progress") {
    clearTurnExpiryTimer(tableId);
    return;
  }

  const expectedTurn = gameState.turn;
  const expectedPlayer = gameState.players[gameState.currentPlayerIndex];
  if (canAutoDeclare41(expectedPlayer)) {
    clearTurnExpiryTimer(tableId);
    void (async () => {
      const autoDeclareLockKey = `lock:auto-declare41:${tableId}:${expectedTurn}:${expectedPlayer?.userId ?? "unknown"}`;
      const lockAcquired = await redisClient.set(autoDeclareLockKey, "locked", {
        NX: true,
        EX: 5,
      });

      if (!lockAcquired) {
        return;
      }

      try {
        const latestState = await loadGameState(tableId);
        if (!latestState || latestState.status !== "in-progress") {
          return;
        }

        const latestPlayer = latestState.players[latestState.currentPlayerIndex];
        if (!latestPlayer) {
          return;
        }

        if (latestState.turn !== expectedTurn || latestPlayer.userId !== expectedPlayer?.userId) {
          return;
        }

        if (!canAutoDeclare41(latestPlayer)) {
          return;
        }

        const resolvedState = await playerDeclare41(latestState, latestPlayer.userId);
        await settleRoundAndBroadcast(io, tableId, resolvedState);
      } catch (error) {
        console.error("Error while auto-resolving 41:", error);
      } finally {
        await redisClient.del(autoDeclareLockKey);
      }
    })();
    return;
  }

  scheduleTurnExpiryTimer(io, tableId, gameState);
  if (gameState.players[gameState.currentPlayerIndex]?.isAI) {
    handleAITurn(io, tableId);
  }
};

const handleTurnExpiration = async (
  io: Server,
  tableId: string,
  expectedTurn: number,
  expectedPlayerId: string
) => {
  const lockKey = `lock:turn-expiration:${tableId}`;
  const lockAcquired = await redisClient.set(lockKey, "locked", {
    NX: true,
    EX: 5,
  });

  if (!lockAcquired) {
    return;
  }

  try {
    const gameState = await loadGameState(tableId);
    if (!gameState || gameState.status !== "in-progress") {
      clearTurnExpiryTimer(tableId);
      return;
    }

    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (!currentPlayer) {
      clearTurnExpiryTimer(tableId);
      return;
    }

    // Guard against stale timers firing after turn already moved.
    if (gameState.turn !== expectedTurn || currentPlayer.userId !== expectedPlayerId) {
      scheduleTurnExpiryTimer(io, tableId, gameState);
      return;
    }

    const playerHasDrawn = currentPlayer.hasDrawnThisTurn ?? currentPlayer.hasTakenActionThisTurn;
    const playerHasDiscarded = currentPlayer.hasDiscardedThisTurn ?? false;

    if (playerHasDiscarded) {
      return;
    }

    if (!playerHasDrawn) {
      const skippedTurnState = {
        ...nextTurn(gameState),
        lastAction: {
          type: "turnExpiredSkip",
          payload: { userId: currentPlayer.userId } as any,
          timestamp: Date.now(),
        },
      };

      await saveGameState(skippedTurnState);
      io.to(tableId).emit("turnExpired", {
        type: "skip",
        userId: currentPlayer.userId,
        username: currentPlayer.username,
        turn: expectedTurn,
        message: `${currentPlayer.username} ran out of time and was skipped.`,
      });
      io.to(tableId).emit("gameStateUpdate", skippedTurnState);
      runTurnLoop(io, tableId, skippedTurnState);
      return;
    }

    let workingState = gameState;
    let actingPlayer = currentPlayer;

    let mandatorySpread = findFirstMandatorySpread(actingPlayer.hand);
    while (mandatorySpread) {
      workingState = await playerSpreadCards(workingState, actingPlayer.userId, mandatorySpread);

      if (workingState.status === "round-end") {
        io.to(tableId).emit("turnExpired", {
          type: "auto-spread",
          userId: currentPlayer.userId,
          username: currentPlayer.username,
          turn: expectedTurn,
          message: `${currentPlayer.username} timed out and auto-played a forced spread.`,
        });
        await settleRoundAndBroadcast(io, tableId, workingState);
        return;
      }

      await saveGameState(workingState);
      io.to(tableId).emit("gameStateUpdate", workingState);

      actingPlayer = workingState.players[workingState.currentPlayerIndex];
      if (!actingPlayer || actingPlayer.userId !== currentPlayer.userId) {
        break;
      }
      mandatorySpread = findFirstMandatorySpread(actingPlayer.hand);
    }

    if (!actingPlayer || actingPlayer.userId !== currentPlayer.userId) {
      runTurnLoop(io, tableId, workingState);
      return;
    }

    const restrictedCardId = actingPlayer.restrictedDiscardCard ?? null;
    const discardableCards = actingPlayer.hand.filter((card) => {
      const id = `${card.rank}-${card.suit}`;
      return restrictedCardId === null || id !== restrictedCardId;
    });
    const randomSource = discardableCards.length > 0 ? discardableCards : actingPlayer.hand;

    if (randomSource.length === 0) {
      const skippedTurnState = {
        ...nextTurn(workingState),
        lastAction: {
          type: "turnExpiredSkipNoDiscard",
          payload: { userId: actingPlayer.userId } as any,
          timestamp: Date.now(),
        },
      };
      await saveGameState(skippedTurnState);
      io.to(tableId).emit("turnExpired", {
        type: "skip",
        userId: actingPlayer.userId,
        username: actingPlayer.username,
        turn: expectedTurn,
        message: `${actingPlayer.username} had no legal auto-discard and was skipped.`,
      });
      io.to(tableId).emit("gameStateUpdate", skippedTurnState);
      runTurnLoop(io, tableId, skippedTurnState);
      return;
    }

    const randomCard = randomSource[Math.floor(Math.random() * randomSource.length)];
    const discardedState = await playerDiscardCard(workingState, actingPlayer.userId, randomCard);

    if (discardedState.status === "round-end") {
      io.to(tableId).emit("turnExpired", {
        type: "auto-discard",
        userId: actingPlayer.userId,
        username: actingPlayer.username,
        turn: expectedTurn,
        card: randomCard,
        message: `${actingPlayer.username} timed out. ${randomCard.rank} of ${randomCard.suit} was auto-discarded.`,
      });
      await settleRoundAndBroadcast(io, tableId, discardedState);
      return;
    }

    await saveGameState(discardedState);
    io.to(tableId).emit("gameStateUpdate", discardedState);

    const nextState = {
      ...nextTurn(discardedState),
      lastAction: {
        type: "turnExpiredAutoDiscard",
        payload: { userId: actingPlayer.userId, card: randomCard } as any,
        timestamp: Date.now(),
      },
    };

    await saveGameState(nextState);
    io.to(tableId).emit("turnExpired", {
      type: "auto-discard",
      userId: actingPlayer.userId,
      username: actingPlayer.username,
      turn: expectedTurn,
      card: randomCard,
      message: `${actingPlayer.username} timed out. ${randomCard.rank} of ${randomCard.suit} was auto-discarded.`,
    });
    io.to(tableId).emit("gameStateUpdate", nextState);
    runTurnLoop(io, tableId, nextState);
  } catch (error) {
    console.error("Error while handling turn expiration:", error);
  } finally {
    await redisClient.del(lockKey);
  }
};

const executeRoundTransition = async (io: Server, tableId: string) => {
  const roundLockKey = `lock:round-transition:${tableId}`;
  const lockAcquired = await redisClient.set(roundLockKey, "locked", {
    NX: true,
    EX: 20,
  });

  if (!lockAcquired) {
    return;
  }

  try {
    clearRoundTransitionTimer(tableId);
    clearTurnExpiryTimer(tableId);

    let table = await Table.findById(tableId);
    if (!table) return;
    const tableMode = table.mode as GameMode;
    const previousGameState = await loadGameState(tableId);
    if (!previousGameState || previousGameState.status !== "round-end") {
      return;
    }

    if (!isContinuousMode(tableMode)) {
      table.status = "waiting";
      table.currentMatchId = undefined;
      if (table.mode === GameMode.USD_CONTEST) {
        table.activeContestId = undefined;
      }
      await table.save();
      io.to(tableId).emit("tableUpdate", {
        message: "Competition session is complete. Start a new session to continue.",
        table,
        gameState: previousGameState,
      });
      return;
    }

    const readySet = new Set(previousGameState.roundReadyPlayerIds ?? []);
    const timeoutRemovalIds = previousGameState.players
      .filter((player) => !player.isAI && !readySet.has(player.userId))
      .map((player) => player.userId);

    const leavingPlayerIds = await redisClient.sMembers(`table:${tableId}:players:leaving`);
    const removeIds = [...new Set([...leavingPlayerIds, ...timeoutRemovalIds])];
    for (const userId of removeIds) {
      const leavingPlayer = previousGameState.players.find((player) => player.userId === userId);
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

    let playersWithDetails = await buildPlayersWithUsernames(table, tableId);
    const humans = playersWithDetails.filter((p) => !p.isAI);
    const ais = playersWithDetails.filter((p) => p.isAI);

    if (humans.length >= table.minPlayers && ais.length > 0) {
      playersWithDetails = humans;
      table.players = humans.map((h) => ({ userId: new mongoose.Types.ObjectId(h.userId), isAI: false })) as any;
      table.currentPlayerCount = humans.length;

      for (const ai of ais) {
        await redisClient.hDel(`table:${tableId}:players`, ai.userId);
      }
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());
      await table.save();
    }

    // Keep games running by backfilling AI seats up to min players when humans remain.
    if (table.currentPlayerCount < table.minPlayers && humans.length > 0) {
      const aiToAdd = table.minPlayers - table.currentPlayerCount;
      for (let i = 0; i < aiToAdd; i++) {
        const aiUserId = new mongoose.Types.ObjectId().toString();
        const aiUsername = `Bot_${Math.random().toString(36).substring(2, 6)}`;
        const aiIdentity = getStandardAiIdentity(aiUserId, aiUsername);
        
        // Find an empty seat for the AI
        let aiSeatIndex = -1;
        for (let i = 0; i < table.maxPlayers; i++) {
          const isSeatTaken = table.players.some(p => p?.seat === i);
          if (!isSeatTaken) {
            aiSeatIndex = i;
            break;
          }
        }

        if (aiSeatIndex !== -1) {
            table.players.push({ 
                userId: new mongoose.Types.ObjectId(aiUserId), 
                isAI: true,
                seat: aiSeatIndex
            } as any);
            table.currentPlayerCount++;
            await redisClient.hSet(
              `table:${tableId}:players`,
              aiUserId,
              JSON.stringify({ username: aiIdentity.username, isAI: true, avatarUrl: aiIdentity.avatarUrl })
            );
        }
      }
      table.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());
      await table.save();
      playersWithDetails = await buildPlayersWithUsernames(table, tableId);
    }

    if (table.currentPlayerCount < table.minPlayers || table.players.length === 0) {
      table.status = "waiting";
      table.currentMatchId = undefined;
      await table.save();
      io.to(tableId).emit("tableUpdate", { message: "Waiting for players to start the next round.", table });
      return;
    }

    const nextDealerIndex =
      (previousGameState.currentDealerIndex + 1) % Math.max(1, playersWithDetails.length);
    console.log(`[DEALER] Dealer rotating from ${previousGameState.currentDealerIndex} to ${nextDealerIndex}`);
    let newGameState = await initializeRoundWithEconomy(table, playersWithDetails, { dealerIndex: nextDealerIndex });
    await saveGameState(newGameState);
    await emitWalletBalanceUpdates(io, tableId, newGameState);

    if (newGameState.status === "round-end") {
      newGameState = await settleRoundAndBroadcast(io, tableId, newGameState);
      io.to(tableId).emit("tableUpdate", {
        message: "Round ended on deal. Preparing next round...",
        table,
        gameState: newGameState,
      });
      io.to(tableId).emit("initialGameState", newGameState);
      return;
    }

    io.to(tableId).emit("tableUpdate", { message: "Starting new round...", table, gameState: newGameState });
    io.to(tableId).emit("initialGameState", newGameState);
    io.to(tableId).emit("gameStateUpdate", newGameState);
    const roundResult = toEngineRoundResult(newGameState);
    if (roundResult) {
      io.to(tableId).emit("roundResult", roundResult);
    }

    runTurnLoop(io, tableId, newGameState);
  } catch (e) {
    console.error("Error in round transition:", e);
  } finally {
    await redisClient.del(roundLockKey);
  }
};

const beginRoundReadyPhase = async (io: Server, tableId: string, gameState: IGameState) => {
  if (gameState.status !== "round-end") {
    return;
  }

  clearRoundTransitionTimer(tableId);
  clearTurnExpiryTimer(tableId);
  const { durationMs: roundReadyDurationMs, isPromo } = await resolveRoundReadyConfig(tableId);

  const aiReadyIds = gameState.players.filter((player) => player.isAI).map((player) => player.userId);
  const updatedGameState: IGameState = {
    ...gameState,
    roundReadyPlayerIds: aiReadyIds,
    roundReadyDeadline: Date.now() + roundReadyDurationMs,
  };

  await saveGameState(updatedGameState);
  io.to(tableId).emit("gameStateUpdate", updatedGameState);

  const timer = setTimeout(() => {
    void executeRoundTransition(io, tableId);
  }, roundReadyDurationMs);
  roundTransitionTimers.set(tableId, timer);

  if (!isPromo && allRoundPlayersReady(updatedGameState)) {
    await executeRoundTransition(io, tableId);
  }
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

        if (aiAction.type === 'declare41') {
           updatedGameState = await playerDeclare41(updatedGameState, currentPlayer.userId);
           await settleRoundAndBroadcast(io, tableId, updatedGameState);
           return;

        } else if (aiAction.type === 'draw') {
           const drawSource = aiAction.payload?.source === 'discard' ? 'discard' : 'deck';
           updatedGameState = await playerDrawCard(updatedGameState, currentPlayer.userId, drawSource);
           if (updatedGameState.status === 'round-end') {
              await settleRoundAndBroadcast(io, tableId, updatedGameState);
              return;
           }

           await saveGameState(updatedGameState);
           io.to(tableId).emit("gameStateUpdate", updatedGameState);
           runTurnLoop(io, tableId, updatedGameState);
           return;

        } else if (aiAction.type === 'discard') {
           if (aiAction.payload?.card) {
               updatedGameState = await playerDiscardCard(updatedGameState, currentPlayer.userId, aiAction.payload.card);

               if (updatedGameState.status === 'round-end') {
                  await settleRoundAndBroadcast(io, tableId, updatedGameState);
                  return;
               }

               await saveGameState(updatedGameState);
               io.to(tableId).emit("gameStateUpdate", updatedGameState);
                
               console.log(`[DEBUG] AI Discard success. Moving to next turn.`);
               const nextGameState = nextTurn(updatedGameState);
               await saveGameState(nextGameState);
               io.to(tableId).emit("gameStateUpdate", nextGameState);
               runTurnLoop(io, tableId, nextGameState);
               return;
           }
        } else if (aiAction.type === 'spread') {
             if (aiAction.payload?.cards) {
               updatedGameState = await playerSpreadCards(updatedGameState, currentPlayer.userId, aiAction.payload.cards);
               if (updatedGameState.status === 'round-end') {
                   await settleRoundAndBroadcast(io, tableId, updatedGameState);
                   return;
               }
               await saveGameState(updatedGameState);
               io.to(tableId).emit("gameStateUpdate", updatedGameState);
               runTurnLoop(io, tableId, updatedGameState);
               return;
             }
        } else if (aiAction.type === 'hit') {
            if (aiAction.payload?.card && aiAction.payload?.targetPlayerId !== undefined && aiAction.payload?.targetSpreadIndex !== undefined) {
              updatedGameState = await playerHitSpread(
                updatedGameState,
                currentPlayer.userId,
                aiAction.payload.card,
                aiAction.payload.targetPlayerId,
                aiAction.payload.targetSpreadIndex
              );
              if (updatedGameState.status === 'round-end') {
                await settleRoundAndBroadcast(io, tableId, updatedGameState);
                return;
              }
              await saveGameState(updatedGameState);
              io.to(tableId).emit("gameStateUpdate", updatedGameState);
              runTurnLoop(io, tableId, updatedGameState);
              return;
            }
        } else if (aiAction.type === 'drop') {
            updatedGameState = await playerDrop(updatedGameState, currentPlayer.userId);
            await settleRoundAndBroadcast(io, tableId, updatedGameState);
            return;
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
  console.log(`[LEAVE] Handling player leave for ${username} (${userId}) from table ${tableId}`);
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
      clearTurnExpiryTimer(tableId);
      clearRoundTransitionTimer(tableId);
      table.players = [];
      table.currentPlayerCount = 0;
      table.status = "waiting";
      table.currentMatchId = undefined;
      if (table.mode === GameMode.USD_CONTEST) {
        table.activeContestId = undefined;
      }
      await table.save();

      // Clear all Redis data for this table
      await redisClient.del(`table:${tableId}:players`);
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", "0");
      await redisClient.del(`game:${tableId}`);

    } else if (table.currentPlayerCount < table.minPlayers && table.status === "in-game") {
      // If game was in progress and now not enough human players (but some humans remain)
      // Remove AI players and set to waiting
      clearTurnExpiryTimer(tableId);
      clearRoundTransitionTimer(tableId);
      table.players = table.players.filter(p => !p.isAI) as any;
      table.currentPlayerCount = table.players.length;
      table.status = "waiting"; // Set to waiting if not enough players
      table.currentMatchId = undefined; // Clear current match if game ends
      if (table.mode === GameMode.USD_CONTEST) {
        table.activeContestId = undefined;
      }
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
    emitLobbyEvent(io, {
      type: "player_left",
      message: `${username} left ${table.name}.`,
      tableId,
      username,
    });
    void emitLobbyPresence(io);
  } finally {
    await redisClient.del(lockKey);
  }
};


// Centralized event handler setup
const setupSocketHandlers = (io: Server) => {
  io.on("connection", (socket: CustomSocket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on("joinLobby", async ({ userId, username }: { userId?: string; username?: string }) => {
      socket.join(LOBBY_ROOM);
      if (userId) {
        await PresenceService.markOnline(userId);
      }
      emitLobbyEvent(io, {
        type: "lobby_join",
        message: username ? `${username} entered the lobby.` : "Player entered the lobby.",
        username,
      });
      void emitLobbyPresence(io, true);
    });

    socket.on("leaveLobby", () => {
      socket.leave(LOBBY_ROOM);
      void emitLobbyPresence(io, true);
    });

    socket.on("presenceHeartbeat", async ({ userId }: { userId?: string }) => {
      if (userId) {
        await PresenceService.markOnline(userId);
      }
      void emitLobbyPresence(io);
    });

    // Event: Player joins a table
    socket.on("joinTable", async ({
      tableId,
      userId,
      username,
      avatarUrl,
      contestId,
      inviteCode,
      spectator,
    }: {
      tableId: string;
      userId: string;
      username: string;
      avatarUrl?: string;
      contestId?: string;
      inviteCode?: string;
      spectator?: boolean;
    }) => {
      console.log(`[JOIN] User ${username} (${userId}) attempting to join table ${tableId}`);
      let table = await Table.findById(tableId);
      if (!table) {
        return socket.emit("gameError", { message: "Table not found." });
      }
      const tableMode = (table.mode as GameMode | undefined)
        ?? ((contestId || table.activeContestId) ? GameMode.USD_CONTEST : GameMode.FREE_RTC_TABLE);
      console.log(`DEBUG: joinTable: tableId=${tableId}, userId=${userId}, isPromo=${table.isPromo}, spectator=${!!spectator}`);

      if (!table.mode) {
        table.mode = tableMode;
      }

      if (spectator) {
        const viewer = await User.findById(userId).select("role isAdmin");
        const viewerRole = viewer ? resolveUserRole(viewer.role, !!viewer.isAdmin) : "user";
        if (!viewer || !roleAtLeast(viewerRole, "admin")) {
          return socket.emit("gameError", { message: "Admin access is required to spectate this table." });
        }
        if (!table.isPromo) {
          return socket.emit("gameError", { message: "Spectator mode is only available for promo tables." });
        }

        socket.join(tableId);
        socket.userId = userId;
        socket.username = username;
        socket.isSpectator = true;
        socket.spectatorTableId = tableId;
        socket.tableId = undefined;
        await PresenceService.markOnline(userId);
        void emitLobbyPresence(io);

        try {
          const promoGameState = await ensurePromoGameState(io, table, userId);
          io.to(socket.id).emit("initialGameState", promoGameState);
          const roundResult = toEngineRoundResult(promoGameState);
          if (roundResult) {
            io.to(socket.id).emit("roundResult", roundResult);
          }
          return;
        } catch (error: any) {
          return socket.emit("gameError", {
            message: error?.message || "Unable to start promo spectator session.",
          });
        }
      }

      // Check if player is already in the table
      const existingPlayer = table.players.find(p => p.userId.toString() === userId);

      if (table.isPrivate && !existingPlayer) {
        const isOwner = table.createdBy?.toString() === userId;
        if (!isOwner) {
          const normalizedCode = typeof inviteCode === "string" ? inviteCode.trim() : "";
          if (!normalizedCode) {
            return socket.emit("gameError", { message: "Invite code required to join this private table." });
          }
          const invite = await Invite.findOne({ code: normalizedCode, tableId: table._id });
          const expired = invite?.expiresAt && invite.expiresAt.getTime() <= Date.now();
          const maxed = invite && invite.maxUses > 0 && invite.uses >= invite.maxUses;
          if (!invite || expired || maxed) {
            return socket.emit("gameError", { message: "Invite code is invalid or expired." });
          }
          await Invite.updateOne(
            { _id: invite._id },
            {
              $set: { lastUsedAt: new Date() },
              $inc: { uses: 1 },
              $addToSet: { usedBy: new mongoose.Types.ObjectId(userId) },
            }
          );
        }
      }

      if (existingPlayer) {
        console.log(`User ${username} (${userId}) is already in table ${tableId}. Rejoining.`);
        socket.join(tableId);
        socket.isSpectator = false;
        socket.spectatorTableId = undefined;
        socket.tableId = tableId;
        socket.userId = userId;
        socket.username = username;
        await PresenceService.markOnline(userId);
        void emitLobbyPresence(io);

        const gameState = await loadGameState(tableId);
        if (gameState) {
          runTurnLoop(io, tableId, gameState);
          const roundResult = toEngineRoundResult(gameState);
          if (roundResult) {
            io.to(socket.id).emit("roundResult", roundResult);
          }
          return io.to(socket.id).emit("initialGameState", gameState); // Send existing state
        } else {
          return socket.emit("gameError", { message: "No active game state found for this table." });
        }
      }

      const existingGameState = await loadGameState(tableId);
      if (
        isCompetitionMode(tableMode) &&
        table.status === "in-game" &&
        existingGameState &&
        existingGameState.status !== "waiting"
      ) {
        return socket.emit("gameError", {
          message: "This competition session is locked. Wait for a new session to start.",
        });
      }

      let usdContest: ContestDocument | null = null;
      if (tableMode === GameMode.USD_CONTEST) {
        try {
          usdContest = await bindPlayerToUsdContest(table, userId, contestId);
          table.activeContestId = usdContest.contestId;
        } catch (error: any) {
          return socket.emit("gameError", {
            message: error?.message || "Unable to join USD contest table.",
          });
        }

        if (table.currentPlayerCount >= usdContest.playerCount) {
          return socket.emit("gameError", { message: "This contest table is full." });
        }
      } else if (table.currentPlayerCount >= table.maxPlayers) {
        return socket.emit("gameError", { message: "Table is full." });
      }

      // Validate player's balance for new joins only (USD contest joins are validated via ContestService).
      if (tableMode !== GameMode.USD_CONTEST) {
        const wallet = await ensureWalletForUser(userId);
        const resolvedStakeAmount = resolveStakeAmountForMode(table.stake, tableMode);
        const requiredEntryBuffer = isContinuousMode(tableMode) ? resolvedStakeAmount * 4 : resolvedStakeAmount;
        const availableForMode = resolveBalanceForMode(wallet, tableMode);
        if (availableForMode < requiredEntryBuffer) {
          return socket.emit("gameError", {
            message: "Insufficient RTC balance to join this table.",
          });
        }
      }

      // Add player to table in MongoDB
      const playerObject = { userId: new mongoose.Types.ObjectId(userId), isAI: false };

      // Find the first empty seat
      let seatIndex = -1;
      for (let i = 0; i < table.maxPlayers; i++) {
        const isSeatTaken = table.players.some(p => p?.seat === i);
        if (!isSeatTaken) {
          seatIndex = i;
          break;
        }
      }

      if (seatIndex === -1) {
        // This should be caught by the maxPlayers check earlier, but as a safeguard
        return socket.emit("gameError", { message: "Table is full (no seats available)." });
      }

      // Assign seat and add player
      (playerObject as any).seat = seatIndex;
      table.players.push(playerObject as any);

      console.log(`[JOIN] User ${username} (${userId}) assigned to seat ${seatIndex} at table ${tableId}`);

      // Sort players by seat index to ensure clockwise order
      table.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
      
      table.currentPlayerCount++;
      // Update Redis for table occupancy
      await redisClient.hSet(`table:${tableId}:players`, userId, JSON.stringify({ username, isAI: false, avatarUrl: avatarUrl ?? null }));
      await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

      // Join the socket room immediately so the player receives updates even if the game starts immediately
      socket.join(tableId);
      console.log(`Socket ${socket.id} explicitly joined room ${tableId} (Pre-game check)`);
      socket.isSpectator = false;
      socket.spectatorTableId = undefined;
      socket.tableId = tableId;
      socket.userId = userId;
      socket.username = username;

      await PresenceService.markOnline(userId);
      emitLobbyEvent(io, {
        type: "table_join",
        message: `${username} joined ${table.name}.`,
        tableId,
        username,
      });
      void emitLobbyPresence(io);
      
      // Check if we need to add an AI to start the game immediately (1 User vs 1 AI)
      if (table.currentPlayerCount === 1 && isCribTableMode(tableMode)) {
          console.log(`Only 1 player in table ${tableId}, adding an AI opponent.`);
          const aiUserId = new mongoose.Types.ObjectId().toString();
          const aiUsername = `Bot_${Math.random().toString(36).substring(2, 6)}`;
          const aiIdentity = getStandardAiIdentity(aiUserId, aiUsername);
          
          // Find an empty seat for the AI
          let aiSeatIndex = -1;
          for (let i = 0; i < table.maxPlayers; i++) {
            const isSeatTaken = table.players.some(p => p?.seat === i);
            if (!isSeatTaken) {
              aiSeatIndex = i;
              break;
            }
          }

          if (aiSeatIndex !== -1) {
               // Add to MongoDB
               table.players.push({ 
                   userId: new mongoose.Types.ObjectId(aiUserId), 
                   isAI: true,
                   seat: aiSeatIndex 
               } as any);
               table.currentPlayerCount++;
               table.players.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
               
               // Add to Redis
               await redisClient.hSet(`table:${tableId}:players`, aiUserId, JSON.stringify({ username: aiIdentity.username, isAI: true, avatarUrl: aiIdentity.avatarUrl }));
               await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());
          }
      }

      let playersInTable = await buildPlayersWithUsernames(table, tableId);
      const requiredPlayersToStart = tableMode === GameMode.USD_CONTEST
        ? (usdContest?.playerCount ?? table.minPlayers)
        : table.minPlayers;
      
      if (table.currentPlayerCount >= requiredPlayersToStart && table.status === "waiting") {
        if (tableMode === GameMode.USD_CONTEST && playersInTable.some((player) => player.isAI)) {
          return socket.emit("gameError", {
            message: "Cash Crown sessions cannot include AI players.",
          });
        }

        table.status = "in-game"; // Set table status to in-game
        
        // Update Redis for any existing AI players (like the one added for 1v1)
        for (const player of playersInTable) {
          if (player.isAI) {
            await redisClient.hSet(
              `table:${tableId}:players`,
              player.userId,
              JSON.stringify({
                username: player.username,
                isAI: true,
                avatarUrl: player.avatarUrl ?? getAiAvatarUrl(player.userId),
              })
            );
          }
        }
        await redisClient.hSet(`table:${tableId}`, "currentPlayerCount", table.currentPlayerCount.toString());

        let gameState: IGameState;
        try {
          if (tableMode === GameMode.USD_CONTEST) {
            const boundContestId = table.activeContestId;
            if (!boundContestId) {
              throw new Error("USD_CONTEST requires a bound contest before session start.");
            }

            const activeContest = usdContest ?? await findContestByAnyId(boundContestId);
            if (!activeContest) {
              throw new Error("Bound contest not found.");
            }

            const humanPlayers = playersInTable.filter((player) => !player.isAI);
            if (humanPlayers.length !== activeContest.playerCount) {
              throw new Error(`Contest requires exactly ${activeContest.playerCount} players to start.`);
            }

            const participantIds = getContestParticipantIds(activeContest);
            if (humanPlayers.some((player) => !participantIds.has(player.userId))) {
              throw new Error("All table players must be registered contest participants.");
            }

            if (activeContest.status !== "in-progress") {
              await ContestService.startContest(activeContest.contestId);
            }
          }

          gameState = await initializeRoundWithEconomy(table, playersInTable);
        } catch (error: any) {
          table.status = "waiting";
          await table.save();
          return socket.emit("gameError", {
            message: error?.message || "Unable to start a new round for this table.",
          });
        }

        table.currentMatchId = new mongoose.Types.ObjectId(); // Create a new Match ID for the table
        await table.save();
        await saveGameState(gameState);
        await emitWalletBalanceUpdates(io, tableId, gameState);
        if (gameState.status === "round-end") {
          gameState = await settleRoundAndBroadcast(io, tableId, gameState);
          const refreshedTable = await Table.findById(tableId);
          if (refreshedTable) {
            table = refreshedTable;
          }
        }
        const startMessage = gameState.status === "round-end"
          ? "Round ended on deal."
          : isContinuousMode(tableMode)
            ? `${username} joined, game starting with AI.`
            : `${username} joined, competition session starting.`;
        io.to(tableId).emit("tableUpdate", { message: startMessage, table, gameState });
        io.to(socket.id).emit("initialGameState", gameState);
        const roundResult = toEngineRoundResult(gameState);
        if (roundResult) {
          io.to(socket.id).emit("roundResult", roundResult);
        }
        runTurnLoop(io, tableId, gameState);
        return; // Exit after starting game
      }

      await table.save();

      console.log(`User ${username} (${userId}) joined table ${tableId}. Current players: ${table.currentPlayerCount}`);

      let gameState: IGameState | null = await loadGameState(tableId);
      if (!gameState) {
        io.to(tableId).emit("tableUpdate", {
          message: `${username} joined the table. Waiting for more players.`,
          table,
        });
        return;
      }

      io.to(tableId).emit("tableUpdate", { message: `${username} joined the table.`, table, gameState });
      io.to(socket.id).emit("initialGameState", gameState);
      const roundResult = toEngineRoundResult(gameState);
      if (roundResult) {
        io.to(socket.id).emit("roundResult", roundResult);
      }
      runTurnLoop(io, tableId, gameState);
    });

    // Event: Player leaves a table (or disconnects)
    socket.on("leaveTable", async ({ tableId, userId, username }: { tableId: string; userId: string; username: string }) => {
      console.log(`[LEAVE] User ${username} (${userId}) leaving table ${tableId}`);
      
      const gameState = await loadGameState(tableId);
      if (gameState && gameState.status === 'in-progress') {
        if (!isContinuousMode(gameState.mode)) {
          return socket.emit("gameError", { message: "This competition is locked until the match is complete." });
        }
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
      const gameState = await loadGameState(tableId);
      if (gameState && !isContinuousMode(gameState.mode)) {
        return socket.emit("gameError", { message: "Leave-between-rounds is only available in FREE_RTC_TABLE mode." });
      }
      if (!gameState || gameState.status !== "in-progress") {
        const table = await Table.findById(tableId);
        const playerInfo = table?.players.find((p) => p.userId.toString() === userId);
        if (playerInfo) {
          const usernameFromTable = playerInfo.isAI ? `AI_${userId.substring(0, 4)}` : socket.username ?? `Player ${userId.substring(0, 4)}`;
          await handlePlayerLeave(io, tableId, userId, usernameFromTable);
        }
        return;
      }

      console.log(`Player ${userId} wants to leave table ${tableId} after the round.`);
      await redisClient.sAdd(`table:${tableId}:players:leaving`, userId);
      socket.emit("ackLeaveRequest");
    });

    socket.on("putIn", async ({ tableId, userId }: { tableId: string; userId: string }) => {
      const gameState = await loadGameState(tableId);
      if (!gameState || gameState.status !== "round-end") {
        return socket.emit("gameError", { message: "Put In is only available between rounds." });
      }
      if (!isContinuousMode(gameState.mode)) {
        return socket.emit("gameError", { message: "Put In is only available in FREE_RTC_TABLE mode." });
      }

      const player = gameState.players.find((p) => p.userId === userId);
      if (!player) {
        return socket.emit("gameError", { message: "Player not found for this round." });
      }

      const readySet = new Set(gameState.roundReadyPlayerIds ?? []);
      readySet.add(userId);
      const updatedGameState: IGameState = {
        ...gameState,
        roundReadyPlayerIds: Array.from(readySet),
      };

      await saveGameState(updatedGameState);
      io.to(tableId).emit("gameStateUpdate", updatedGameState);

      if (allRoundPlayersReady(updatedGameState)) {
        await executeRoundTransition(io, tableId);
      }
    });

    // Event: Player draws a card
    socket.on("drawCard", async ({ tableId, userId, source }: { tableId: string; userId: string; source: 'deck' | 'discard' }) => {
      console.log(`User ${userId} drew a card from ${source} in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerDrawCard(gameState, userId, source);
          if (updatedGameState.status === "round-end") {
             await settleRoundAndBroadcast(io, tableId, updatedGameState);
             console.log(`Round ended (Deck Empty) in table ${tableId}`);
             return;
          }

          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          runTurnLoop(io, tableId, updatedGameState);

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

          if (updatedGameState.status === "round-end") {
            await settleRoundAndBroadcast(io, tableId, updatedGameState);
            return;
          }

          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          
          // After discarding, it\'s usually the next player\'s turn
          const nextGameState = nextTurn(updatedGameState);
          
          await saveGameState(nextGameState);
          io.to(tableId).emit("gameStateUpdate", nextGameState);
          runTurnLoop(io, tableId, nextGameState);
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
          if (updatedGameState.status === "round-end") {
            // Handle Reem case - round ends instantly
            console.log(`Player ${userId} Reemed! Round ends.`);
            await settleRoundAndBroadcast(io, tableId, updatedGameState);
          } else {
            await saveGameState(updatedGameState);
            io.to(tableId).emit("gameStateUpdate", updatedGameState);
            runTurnLoop(io, tableId, updatedGameState);
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

          if (updatedGameState.status === "round-end") {
            await settleRoundAndBroadcast(io, tableId, updatedGameState);
            return;
          }

          await saveGameState(updatedGameState);
          io.to(tableId).emit("gameStateUpdate", updatedGameState);
          runTurnLoop(io, tableId, updatedGameState);
          // After hitting, the player must discard one card.
          // This logic will be more complex and managed by turn flow.
        } catch (error: any) {
          socket.emit("gameError", { message: error.message });
        }
      }
    });

    // Event: Player declares 41
    socket.on("declare41", async ({ tableId, userId }: { tableId: string; userId: string }) => {
      console.log(`User ${userId} declared 41 in table ${tableId}`);
      let gameState = await loadGameState(tableId);
      if (gameState) {
        try {
          const updatedGameState = await playerDeclare41(gameState, userId);
          await settleRoundAndBroadcast(io, tableId, updatedGameState);
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
          // Round ends after a drop. Settlement is handled by the mode controller.
          console.log(`Player ${userId} dropped. Round ends.`);
          await settleRoundAndBroadcast(io, tableId, updatedGameState);
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
        const roundResult = toEngineRoundResult(gameState);
        if (roundResult) {
          socket.emit("roundResult", roundResult);
        }
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
      if (!socket.isSpectator && socket.tableId && socket.userId && socket.username) {
        await handlePlayerLeave(io, socket.tableId, socket.userId, socket.username);
      }
      void emitLobbyPresence(io, true);
    });
  });
};

export default setupSocketHandlers;
