import { Card, createDeck, shuffleDeck, dealCards, CardRank, CardSuit } from './deck';
import { redisClient } from '../config/redis';
import Table, { TableDocument } from '../models/Table';
import Wallet from '../models/Wallet'; // Import Wallet
import Match from '../models/Match'; // Import Match
import Transaction from '../models/Transaction'; // Import Transaction
import mongoose from 'mongoose';

// Represents the live state of a game table in Redis
export interface IGameState {
  tableId: string;
  currentDealerIndex: number;
  players: Array<{
    userId: string;
    username: string;
    hand: Card[];
    isAI: boolean;
    isHitLocked: boolean;
    hitLockCounter: number;
    spreads: Card[][];
    hasTakenActionThisTurn: boolean; // To track if any action (draw, spread, hit) was taken
    currentBuyIn: number; // Player's buy-in for the current round
    restrictedDiscardCard: string | null; // Card that cannot be discarded this turn (e.g. if picked from discard pile)
  }>;
  deck: Card[];
  discardPile: Card[];
  turn: number;
  currentPlayerIndex: number;
  lastAction: { type: string; payload: any; timestamp: number } | null;
  status: 'waiting' | 'starting' | 'in-progress' | 'round-end' | 'game-end';
  baseStake: number;
  roundWins: { [userId: string]: number };
  pot: number; // The total pot for the current round
  lockedAntes: { [userId: string]: number };
  roundEndedBy: 'REGULAR' | 'REEM' | 'AUTO_TRIPLE' | 'CAUGHT_DROP' | 'DECK_EMPTY' | null; // How the round ended
  roundWinnerId?: string;
  roundLoserId?: string;
  caughtDroppingPlayerId?: string; // If a player was caught dropping
  handScores?: { [userId: string]: number }; // Stores final hand scores for all players at round end
  payouts?: { [userId: string]: number };
  // Other game state properties
}

/**
 * Calculates the total value of a player's hand.
 * Ace = 1, 2-7 = face value, J/Q/K = 10.
 * @param hand The player's hand.
 * @returns The total hand value.
 */
export const calculateHandValue = (hand: Card[]): number => {
  return hand.reduce((sum, card) => sum + card.value, 0);
};

/**
 * Helper to calculate hand scores for all players.
 * @param players List of players.
 * @returns An object mapping userId to hand score.
 */
export const calculateAllHandScores = (players: Array<{ userId: string; hand: Card[] }>): { [userId: string]: number } => {
  const scores: { [userId: string]: number } = {};
  for (const player of players) {
    scores[player.userId] = calculateHandValue(player.hand);
  }
  return scores;
};

/**
 * Checks for automatic win conditions (50, 47, 41, or <=11) after dealing.
 * @param players The players in the game with their dealt hands.
 * @returns The userId of the winning player and the multiplier, or null if no auto-win.
 */
export const checkForAutomaticWins = (players: Array<{ userId: string; hand: Card[] }>): { winnerId: string; type: 'REGULAR' | 'AUTO_TRIPLE' } | null => {
  let autoWin: { winnerId: string; type: 'REGULAR' | 'AUTO_TRIPLE' } | null = null;
  let hasAutoTriple = false;

  for (const player of players) {
    const handValue = calculateHandValue(player.hand);

    if (handValue === 41 || handValue <= 11) {
      // If a triple win is found, it takes precedence
      autoWin = { winnerId: player.userId, type: 'AUTO_TRIPLE' };
      hasAutoTriple = true;
      break; // Exit loop once a triple win is found
    } else if ((handValue === 50 || handValue === 47) && !hasAutoTriple) {
      // Regular auto win, only considered if no triple win has been found yet
      autoWin = { winnerId: player.userId, type: 'REGULAR' };
    }
  }
  return autoWin;
};

/**
 * Handles the buy-in for all players in a round.
 * Deducts the stake from each human player's wallet.
 * @param gameState The current game state.
 * @returns The updated game state with buy-ins recorded and updated currentPot.
 */
export const handleBuyIn = async (gameState: IGameState): Promise<IGameState> => {
  let updatedPot = gameState.pot;
  const updatedLockedAntes = { ...gameState.lockedAntes };
  const updatedPlayers = await Promise.all(gameState.players.map(async (player) => {
    // For all players (including AI for pot calculation), lock the ante
    updatedPot += gameState.baseStake;
    updatedLockedAntes[player.userId] = gameState.baseStake;

    if (!player.isAI) {
      const playerWallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(player.userId) });
      
      if (!playerWallet) {
        // This should ideally not happen if players are validated before joining
        throw new Error(`Wallet not found for player ${player.username}.`);
      }

      // Validate if player can cover the ante
      if (playerWallet.availableBalance < gameState.baseStake) {
        throw new Error(`Player ${player.username} has insufficient funds for the ante.`);
      }

      // Deduct ante immediately so round-end reflects the stake loss.
      playerWallet.availableBalance -= gameState.baseStake;
      await playerWallet.save();
    }
    
    return { ...player, currentBuyIn: gameState.baseStake };
  }));

  return { ...gameState, players: updatedPlayers, pot: updatedPot, lockedAntes: updatedLockedAntes };
};

/**
 * Handles payouts at the end of a round.
 * Updates player wallets and match history in MongoDB.
 * @param gameState The final game state of the round.
 * @returns The updated game state after payouts.
 */
export const handleRoundEndPayouts = async (gameState: IGameState): Promise<IGameState> => {
  if (gameState.status !== 'round-end') {
    return gameState;
  }

  const payoutData = calculatePayouts(gameState);
  await settleWallets(gameState, payoutData);
  const baseLosses: { [userId: string]: number } = {};
  for (const player of gameState.players) {
    if (player.userId !== gameState.roundWinnerId) {
      baseLosses[player.userId] = gameState.baseStake;
    }
  }

  const updatedGameState = {
    ...gameState,
    payouts: {
      [gameState.roundWinnerId!]: payoutData.winnerPayout,
      ...Object.entries(baseLosses).reduce((acc, [playerId, amount]) => {
        acc[playerId] = -amount;
        return acc;
      }, {} as { [userId: string]: number }),
      ...payoutData.penalties.reduce((acc, p) => {
        const existing = acc[p.playerId] ?? 0;
        acc[p.playerId] = existing - p.amount;
        return acc;
      }, {} as { [userId: string]: number }),
    },
  };
  
  return updatedGameState;
};

export const calculatePayouts = (gameState: IGameState): { winnerPayout: number; penalties: { playerId: string; amount: number }[] } => {
  const { pot, baseStake, roundEndedBy, roundWinnerId, caughtDroppingPlayerId, players } = gameState;
  let winnerPayout = 0;
  const penalties: { playerId: string; amount: number }[] = [];
  const losers = players.filter(p => p.userId !== roundWinnerId);

  if (!roundWinnerId) {
    return { winnerPayout: 0, penalties: [] };
  }

  switch (roundEndedBy) {
    case 'REGULAR':
    case 'DECK_EMPTY':
      winnerPayout = pot;
      break;
    case 'REEM':
      winnerPayout = pot + (baseStake * losers.length);
      losers.forEach(loser => {
        penalties.push({ playerId: loser.userId, amount: baseStake });
      });
      break;
    case 'AUTO_TRIPLE':
      const penaltyAmount = baseStake * 3;
      winnerPayout = pot + (penaltyAmount * losers.length);
      losers.forEach(loser => {
        penalties.push({ playerId: loser.userId, amount: penaltyAmount });
      });
      break;
    case 'CAUGHT_DROP':
      if (caughtDroppingPlayerId) {
        winnerPayout = pot + baseStake;
        penalties.push({ playerId: caughtDroppingPlayerId, amount: baseStake });
      }
      break;
  }

  return { winnerPayout, penalties };
};

const settleWallets = async (gameState: IGameState, payoutData: { winnerPayout: number; penalties: { playerId: string; amount: number }[] }) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { tableId, roundWinnerId, players, pot, roundEndedBy } = gameState;
    const { winnerPayout, penalties } = payoutData;

    if (!roundWinnerId) {
      throw new Error("Cannot settle wallets without a winner.");
    }
    
    // Credit winner
    const winnerWallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(roundWinnerId) }).session(session);
    if (winnerWallet) {
      winnerWallet.availableBalance += winnerPayout;
      // Also record in earnings history, if you keep this separate
      winnerWallet.matchEarningsHistory.push({ matchId: new mongoose.Types.ObjectId(), amount: winnerPayout, date: new Date() });
      await winnerWallet.save({ session });

      // Create transaction for winner
      const winTransaction = new Transaction({
        userId: new mongoose.Types.ObjectId(roundWinnerId),
        type: 'Win',
        amount: winnerPayout,
        status: 'Completed',
        details: { matchId: new mongoose.Types.ObjectId() } // This should be the actual matchId once it's created
      });
      await winTransaction.save({ session });
    }

    // Debit penalized players
    for (const penalty of penalties) {
      const loserWallet = await Wallet.findOne({ userId: new mongoose.Types.ObjectId(penalty.playerId) }).session(session);
      if (loserWallet) {
        loserWallet.availableBalance -= penalty.amount;
        if (loserWallet.availableBalance < 0) {
          // This should be prevented by pre-game validation
          throw new Error(`Player ${penalty.playerId} has insufficient funds to cover penalty.`);
        }
        loserWallet.matchEarningsHistory.push({ matchId: new mongoose.Types.ObjectId(), amount: -penalty.amount, date: new Date() });
        await loserWallet.save({ session });

        // Create transaction for loser
        const lossTransaction = new Transaction({
            userId: new mongoose.Types.ObjectId(penalty.playerId),
            type: 'Loss',
            amount: -penalty.amount,
            status: 'Completed',
            details: { matchId: new mongoose.Types.ObjectId() } // This should be the actual matchId once it's created
        });
        await lossTransaction.save({ session });
      }
    }

    // Create match record
    const match = new Match({
      tableId,
      players: players.map(p => ({
        userId: p.userId,
        username: p.username,
        stake: gameState.baseStake,
        buyIn: p.currentBuyIn,
        payout: p.userId === roundWinnerId
          ? winnerPayout
          : -gameState.baseStake - (penalties.find(pen => pen.playerId === p.userId)?.amount || 0),
        isAI: p.isAI,
        finalHandValue: gameState.handScores ? gameState.handScores[p.userId] : 0,
      })),
      winner: roundWinnerId,
      winType: roundEndedBy,
      pot,
      winnerPayout,
      penalties,
      status: 'completed',
    });
    await match.save({ session });

    // Now that the match is saved, we can update the transactions with the correct matchId
    await Transaction.updateMany(
        { "details.matchId": new mongoose.Types.ObjectId() }, // Temporary matchId
        { "details.matchId": match._id },
        { session }
    );

    await session.commitTransaction();
  } catch (error) {
    await session.abortTransaction();
    console.error("Wallet settlement transaction failed:", error);
    throw error;
  } finally {
    session.endSession();
  }
};

/**
 * Initializes a new game for a given table.
 * @param table The table to start the game on.
 * @param players The players participating in the game.
 * @returns The initial game state.
 */
export const initializeGame = async (table: TableDocument, players: Array<{ userId: string; username: string; isAI: boolean }>): Promise<IGameState> => {
  const fullDeck = createDeck();
  const shuffledDeck = shuffleDeck(fullDeck);
  const { remainingDeck, playerHands } = dealCards(shuffledDeck, players.length, 5);

  const initialPlayersState = players.map((player, index) => ({
    userId: player.userId.toString(),
    username: player.username,
    hand: playerHands[index],
    isAI: player.isAI,
    isHitLocked: false,
    hitLockCounter: 0,
    spreads: [],
    hasTakenActionThisTurn: false,
    currentBuyIn: 0, // Initial buy-in is 0, handled by handleBuyIn
    restrictedDiscardCard: null,
  }));

  let initialGameState: IGameState = {
    tableId: table._id.toString(),
    currentDealerIndex: 0, // Will rotate
    players: initialPlayersState,
    deck: remainingDeck,
    discardPile: [],
    turn: 1,
    currentPlayerIndex: 0, // Start with the player after the dealer
    lastAction: null,
    status: 'starting', // Explicitly set as literal type
    baseStake: table.stake,
    roundWins: {}, // Track round wins for each player
    pot: 0, // Initialize pot to 0
    lockedAntes: {},
    roundEndedBy: null,
  };

  // Handle buy-in for all players
  initialGameState = await handleBuyIn(initialGameState);

  // Check for automatic wins immediately after dealing (and buy-in)
  const autoWinResult = checkForAutomaticWins(initialPlayersState.map(p => ({ userId: p.userId, hand: p.hand })));
  if (autoWinResult) {
    // If there's an auto-win, the round ends immediately
    const winningPlayer = initialPlayersState.find(p => p.userId === autoWinResult.winnerId);
    if (winningPlayer) {
      const finalGameState: IGameState = { // Explicitly type finalGameState
        ...initialGameState,
        currentDealerIndex: 0, // Not relevant as round ends
        currentPlayerIndex: -1, // No active player
        lastAction: { type: 'autoWin', payload: autoWinResult as any, timestamp: Date.now() },
        status: 'round-end', // Explicitly set as literal type
        roundEndedBy: autoWinResult.type,
        roundWinnerId: autoWinResult.winnerId,
        handScores: calculateAllHandScores(initialGameState.players),
      };
      // Handle payouts for auto-win
      return await handleRoundEndPayouts(finalGameState);
    }
  }

  return initialGameState;
};

/**
 * Saves the current game state to Redis.
 * @param gameState The game state to save.
 */
export const saveGameState = async (gameState: IGameState) => {
  await redisClient.set(`game:${gameState.tableId}`, JSON.stringify(gameState));
};

/**
 * Loads the game state from Redis.
 * @param tableId The ID of the table.
 * @returns The game state or null if not found.
 */
export const loadGameState = async (tableId: string): Promise<IGameState | null> => {
  const gameStateString = await redisClient.get(`game:${tableId}`);
  return gameStateString ? JSON.parse(gameStateString) : null;
};

/**
 * Advances the game to the next player's turn.
 * @param gameState The current game state.
 * @returns The updated game state.
 */
export const nextTurn = (gameState: IGameState): IGameState => {
  const nextPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  const updatedPlayers = gameState.players.map((player, index) => ({
    ...player,
    hasTakenActionThisTurn: false, // Reset for new turn
    hitLockCounter: Math.max(0, player.hitLockCounter - 1),
    isHitLocked: player.hitLockCounter > 0,
    restrictedDiscardCard: null,
  }));

  return {
    ...gameState,
    currentPlayerIndex: nextPlayerIndex,
    turn: gameState.turn + 1,
    lastAction: null,
    players: updatedPlayers,
  };
};

/**
 * Handles a player drawing a card.
 * @param gameState The current game state.
 * @param userId The ID of the player drawing the card.
 * @returns The updated game state.
 */
export const playerDrawCard = async (gameState: IGameState, userId: string, source: 'deck' | 'discard' = 'deck'): Promise<IGameState> => {
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  const player = gameState.players[playerIndex];
  let newDeck = [...gameState.deck];
  let newDiscardPile = [...gameState.discardPile];
  const newHand = [...player.hand];
  let drawnCard: Card | undefined;
  let restrictedDiscardCard: string | null = null;

  if (source === 'discard') {
    if (newDiscardPile.length === 0) {
      throw new Error('Discard pile is empty.');
    }
    drawnCard = newDiscardPile.pop();
    if (drawnCard) {
      restrictedDiscardCard = `${drawnCard.rank}-${drawnCard.suit}`;
    }
  } else {
    drawnCard = newDeck.shift();
  }

  if (!drawnCard) {
    // Deck is empty, end the round and determine winner by lowest hand value
    let lowestScore = Infinity;
    let winnerId = '';
    
    // Simple logic to find lowest score
    for (const p of gameState.players) {
        const score = calculateHandValue(p.hand);
        if (score < lowestScore) {
            lowestScore = score;
            winnerId = p.userId;
        }
    }

    const updatedGameState: IGameState = {
        ...gameState,
        status: 'round-end',
        roundEndedBy: 'DECK_EMPTY',
        roundWinnerId: winnerId,
        lastAction: { type: 'deckEmpty', payload: { winnerId, lowestScore } as any, timestamp: Date.now() },
        handScores: calculateAllHandScores(gameState.players),
    };
    
    return await handleRoundEndPayouts(updatedGameState);
  }

  newHand.push(drawnCard);

  const updatedPlayers = [...gameState.players];
  updatedPlayers[playerIndex] = {
    ...player,
    hand: newHand,
    hasTakenActionThisTurn: true,
    restrictedDiscardCard: restrictedDiscardCard
  };

  return {
    ...gameState,
    deck: newDeck,
    discardPile: newDiscardPile,
    players: updatedPlayers,
    lastAction: { type: 'drawCard', payload: { userId, card: drawnCard, source } as any, timestamp: Date.now() },
  };
};

/**
 * Handles a player discarding a card.
 * @param gameState The current game state.
 * @param userId The ID of the player discarding the card.
 * @param cardToDiscard The card to discard.
 * @returns The updated game state.
 */
export const playerDiscardCard = (gameState: IGameState, userId: string, cardToDiscard: Card): IGameState => {
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  const player = gameState.players[playerIndex];
  const newHand = [...player.hand];

  // Check if the card is restricted
  const cardId = `${cardToDiscard.rank}-${cardToDiscard.suit}`;
  if (player.restrictedDiscardCard === cardId) {
    throw new Error(`Cannot discard the card that was just picked up from the discard pile.`);
  }

  const cardIndex = newHand.findIndex(card => card.rank === cardToDiscard.rank && card.suit === cardToDiscard.suit);
  if (cardIndex === -1) {
    throw new Error(`Player ${userId} does not have card ${cardToDiscard.rank} of ${cardToDiscard.suit} to discard.`);
  }

  newHand.splice(cardIndex, 1);

  const updatedPlayers = [...gameState.players];
  updatedPlayers[playerIndex] = { ...player, hand: newHand, hasTakenActionThisTurn: true };

  const newDiscardPile = [...gameState.discardPile, cardToDiscard];

  return {
    ...gameState,
    players: updatedPlayers,
    discardPile: newDiscardPile,
    lastAction: { type: 'discardCard', payload: { userId, card: cardToDiscard } as any, timestamp: Date.now() },
  };
};

// Helper to get card value for sorting and sequence checking
const getCardNumericalRank = (rank: CardRank): number => {
  const ranks = ['Ace', '2', '3', '4', '5', '6', '7', 'Jack', 'Queen', 'King'];
  return ranks.indexOf(rank);
};

/**
 * Validates if a set of cards forms a valid spread (3+ same rank OR 3+ consecutive same suit).
 * @param cards The array of cards to validate.
 * @returns True if the cards form a valid spread, false otherwise.
 */
export const isValidSpread = (cards: Card[]): boolean => {
  if (cards.length < 3) {
    return false; // A spread requires at least 3 cards
  }

  // Check for same rank spread
  const allSameRank = cards.every(card => card.rank === cards[0].rank);
  if (allSameRank) {
    return true;
  }

  // Check for consecutive same suit spread
  const allSameSuit = cards.every(card => card.suit === cards[0].suit);
  if (!allSameSuit) {
    return false;
  }

  const sortedCards = [...cards].sort((a, b) => getCardNumericalRank(a.rank) - getCardNumericalRank(b.rank));

  for (let i = 0; i < sortedCards.length - 1; i++) {
    if (getCardNumericalRank(sortedCards[i + 1].rank) - getCardNumericalRank(sortedCards[i].rank) !== 1) {
      return false; // Not consecutive
    }
  }

  return true;
};

export const checkReem = (gameState: IGameState, userId: string): boolean => {
  const player = gameState.players.find(p => p.userId === userId);
  if (!player) return false;
  // A reem is when a player spreads for the second time AND has no cards left.
  return player.spreads.length === 2 && player.hand.length === 0;
};

/**
 * Handles a player spreading cards.
 * @param gameState The current game state.
 * @param userId The ID of the player spreading the cards.
 * @param cardsToSpread The array of cards to spread.
 * @returns The updated game state.
 */
export const playerSpreadCards = async (gameState: IGameState, userId: string, cardsToSpread: Card[]): Promise<IGameState> => {
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  const player = gameState.players[playerIndex];
  let newHand = [...player.hand];
  let newSpreads = [...player.spreads];

  // 1. Validate the spread
  if (!isValidSpread(cardsToSpread)) {
    throw new Error("Invalid spread: Cards do not form a valid set or run.");
  }

  // 2. Ensure player has the cards in hand
  const handCardMap = new Map<string, number>();
  for (const card of newHand) {
    const cardKey = `${card.rank}-${card.suit}`;
    handCardMap.set(cardKey, (handCardMap.get(cardKey) || 0) + 1);
  }

  for (const spreadCard of cardsToSpread) {
    const cardKey = `${spreadCard.rank}-${spreadCard.suit}`;
    if (!handCardMap.has(cardKey) || (handCardMap.get(cardKey) || 0) <= 0) {
      throw new Error(`Player ${userId} does not have card ${spreadCard.rank} of ${spreadCard.suit} in hand.`);
    }
    handCardMap.set(cardKey, (handCardMap.get(cardKey) || 0) - 1);
  }

  // 3. Remove cards from hand
  for (const spreadCard of cardsToSpread) {
    const index = newHand.findIndex(card => card.rank === spreadCard.rank && card.suit === spreadCard.suit);
    if (index !== -1) {
      newHand.splice(index, 1);
    }
  }

  // 4. Add to player's spreads
  newSpreads.push(cardsToSpread);

  // 5. Update player's spread count for the turn
  const updatedPlayer = {
    ...player,
    hand: newHand,
    spreads: newSpreads,
    hasTakenActionThisTurn: true,
  };

  const updatedPlayers = [...gameState.players];
  updatedPlayers[playerIndex] = updatedPlayer;

  let updatedGameState: IGameState = { // Explicitly type updatedGameState
    ...gameState,
    players: updatedPlayers,
    lastAction: { type: 'spread', payload: { userId, cards: cardsToSpread } as any, timestamp: Date.now() },
  };

  // Check for Reem after spreading
  if (checkReem(updatedGameState, userId)) {
    updatedGameState = {
      ...updatedGameState,
      status: 'round-end',
      lastAction: { type: 'reem', payload: { userId } as any, timestamp: Date.now() },
      roundEndedBy: 'REEM',
      roundWinnerId: userId,
      handScores: calculateAllHandScores(updatedGameState.players),
    };
    // Handle payouts for Reem
    updatedGameState = await handleRoundEndPayouts(updatedGameState); // Await payouts
  }

  return updatedGameState;
};

/**
 * Validates if a card can be added to an existing spread.
 * @param spread The existing spread.
 * @param cardToAdd The card to add.
 * @returns True if the card can be added, false otherwise.
 */
const canHitSpread = (spread: Card[], cardToAdd: Card): boolean => {
  if (spread.length === 0) return false;

  // Check for same rank spread (e.g., three 5s, adding a fourth 5)
  const isSameRankSpread = spread.every(c => c.rank === spread[0].rank);
  if (isSameRankSpread) {
    return cardToAdd.rank === spread[0].rank && !spread.some(c => c.suit === cardToAdd.suit);
  }

  // Check for consecutive same suit spread (e.g., 2,3,4 of Hearts, adding Ace or 5 of Hearts)
  const isSameSuitSpread = spread.every(c => c.suit === spread[0].suit);
  if (isSameSuitSpread) {
    const sortedSpread = [...spread].sort((a, b) => getCardNumericalRank(a.rank) - getCardNumericalRank(b.rank));
    const minRank = getCardNumericalRank(sortedSpread[0].rank);
    const maxRank = getCardNumericalRank(sortedSpread[sortedSpread.length - 1].rank);
    const cardToAddRank = getCardNumericalRank(cardToAdd.rank);

    // Can add to either end of the sequence, if same suit
    return (
      cardToAdd.suit === spread[0].suit &&
      (cardToAddRank === minRank - 1 || cardToAddRank === maxRank + 1)
    );
  }

  return false;
};

/**
 * Handles a player hitting a spread.
 * @param gameState The current game state.
 * @param hittingPlayerId The ID of the player hitting the spread.
 * @param cardToHitWith The card to use for hitting.
 * @param targetPlayerId The ID of the player whose spread is being hit.
 * @param targetSpreadIndex The index of the spread to hit within the target player's spreads.
 * @returns The updated game state.
 */
export const playerHitSpread = async (
  gameState: IGameState,
  hittingPlayerId: string,
  cardToHitWith: Card,
  targetPlayerId: string,
  targetSpreadIndex: number
): Promise<IGameState> => {
  const hittingPlayerIndex = gameState.players.findIndex(p => p.userId === hittingPlayerId);
  if (hittingPlayerIndex === -1) {
    throw new Error(`Hitting player ${hittingPlayerId} not found.`);
  }
  const hittingPlayer = gameState.players[hittingPlayerIndex];

  const targetPlayerIndex = gameState.players.findIndex(p => p.userId === targetPlayerId);
  if (targetPlayerIndex === -1) {
    throw new Error(`Target player ${targetPlayerId} not found.`);
  }
  let targetPlayer = gameState.players[targetPlayerIndex];

  // 1. Ensure hitting player has the card
  const cardInHandIndex = hittingPlayer.hand.findIndex(card =>
    card.rank === cardToHitWith.rank && card.suit === cardToHitWith.suit
  );
  if (cardInHandIndex === -1) {
    throw new Error(`Player ${hittingPlayerId} does not have card ${cardToHitWith.rank} of ${cardToHitWith.suit} in hand to hit.`);
  }

  // 2. Validate target spread exists
  if (targetSpreadIndex < 0 || targetSpreadIndex >= targetPlayer.spreads.length) {
    throw new Error(`Invalid target spread index ${targetSpreadIndex} for player ${targetPlayerId}.`);
  }
  const targetSpread = targetPlayer.spreads[targetSpreadIndex];

  // 3. Validate if the card can hit the spread
  if (!canHitSpread(targetSpread, cardToHitWith)) {
    throw new Error(`Card ${cardToHitWith.rank} of ${cardToHitWith.suit} cannot hit the target spread.`);
  }

  // Perform the hit
  // Remove card from hitting player's hand
  const updatedHittingHand = [...hittingPlayer.hand];
  updatedHittingHand.splice(cardInHandIndex, 1);

  // Add card to target spread
  const updatedTargetSpread = [...targetSpread, cardToHitWith].sort((a, b) => getCardNumericalRank(a.rank) - getCardNumericalRank(b.rank));
  const updatedTargetPlayerSpreads = [...targetPlayer.spreads];
  updatedTargetPlayerSpreads[targetSpreadIndex] = updatedTargetSpread;

  // Update hit lock for the target player
  const newHitLockCounter = targetPlayer.hitLockCounter + (targetPlayer.isHitLocked ? 1 : 2);
  targetPlayer = {
    ...targetPlayer,
    spreads: updatedTargetPlayerSpreads,
    isHitLocked: true,
    hitLockCounter: newHitLockCounter,
  };

  const updatedHittingPlayer = { ...hittingPlayer, hand: updatedHittingHand, hasTakenActionThisTurn: true };

  const updatedPlayers = [...gameState.players];
  updatedPlayers[hittingPlayerIndex] = updatedHittingPlayer;
  updatedPlayers[targetPlayerIndex] = targetPlayer;

  return {
    ...gameState,
    players: updatedPlayers,
    lastAction: { type: 'hit', payload: { hittingPlayerId, card: cardToHitWith, targetPlayerId, targetSpreadIndex } as any, timestamp: Date.now() },
  };
};

/**
 * Handles a player dropping.
 * @param gameState The current game state.
 * @param userId The ID of the player dropping.
 * @returns The updated game state (round ended).
 */
export const playerDrop = async (gameState: IGameState, userId: string): Promise<IGameState> => {
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  const player = gameState.players[playerIndex];

  // 1. Validate drop conditions
  if (gameState.currentPlayerIndex !== playerIndex) {
    throw new Error(`It is not player ${userId}'s turn to drop.`);
  }
  if (player.hasTakenActionThisTurn) {
    throw new Error(`Player ${userId} cannot drop after taking an action this turn.`);
  }
  if (player.isHitLocked) {
    throw new Error(`Player ${userId} cannot drop while hit-locked.`);
  }

  // Acknowledge drop and end the round
  let updatedGameState: IGameState = {
    ...gameState,
    status: 'round-end',
    lastAction: { type: 'drop', payload: { userId, handValue: calculateHandValue(player.hand) } as any, timestamp: Date.now() },
    roundEndedBy: 'REGULAR',
    roundWinnerId: userId, // Assuming the dropper is the potential winner unless caught
    handScores: calculateAllHandScores(gameState.players),
  };

  // TODO: Implement logic for caught dropping. For now, assume not caught.
  updatedGameState = await handleRoundEndPayouts(updatedGameState); // Await payouts
  return updatedGameState;
};
