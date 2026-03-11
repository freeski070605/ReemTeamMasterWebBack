import { Card, createDeck, shuffleDeck, dealCards, CardRank, CardSuit } from './deck';
import { redisClient } from '../config/redis';
import { resolveStakeAmountForMode } from '../config/economy';
import Table, { TableDocument } from '../models/Table';
import { DEFAULT_GAME_MODE, GameMode } from '../domain/gameMode';

export type RoundEndType = 'REGULAR' | 'REEM' | 'AUTO_TRIPLE' | 'CAUGHT_DROP' | 'DECK_EMPTY';
export type PlacementWinType = RoundEndType | 'LOSS';
export const DEFAULT_TURN_DURATION_MS = 20_000;

export interface IPlacement {
  userId: string;
  rank: number;
  winType: PlacementWinType;
}

export interface IEngineRoundResult {
  sessionId: string;
  mode: GameMode;
  placements: Array<{
    userId: string;
    rank: number;
    winType: PlacementWinType;
  }>;
}

// Represents the live state of a game table in Redis
export interface IGameState {
  tableId: string;
  mode?: GameMode;
  contestId?: string | null;
  currentDealerIndex: number;
  players: Array<{
    userId: string;
    username: string;
    avatarUrl?: string;
    hand: Card[];
    isAI: boolean;
    isHitLocked: boolean;
    hitLockCounter: number;
    spreads: Card[][];
    hasTakenActionThisTurn: boolean; // To track if any action (draw, spread, hit) was taken
    hasDrawnThisTurn: boolean;
    hasDiscardedThisTurn: boolean;
    hasDrawnAnyCard: boolean; // Tracks whether the player has drawn at least once this round
    startingHandValue: number;
    lastHitAppliedOnTurn: number | null; // Prevents multiple hits in the same turn from stacking lock
    currentBuyIn: number; // Player's buy-in for the current round
    restrictedDiscardCard: string | null; // Card that cannot be discarded this turn (e.g. if picked from discard pile)
  }>;
  deck: Card[];
  discardPile: Card[];
  turn: number;
  currentPlayerIndex: number;
  turnStartTime: number;
  turnDurationMs: number;
  turnExpiresAt: number;
  lastAction: { type: string; payload: any; timestamp: number } | null;
  status: 'waiting' | 'starting' | 'in-progress' | 'round-end' | 'game-end';
  baseStake: number;
  roundWins: { [userId: string]: number };
  pot: number; // The total pot for the current round
  lockedAntes: { [userId: string]: number };
  roundEndedBy: RoundEndType | null; // How the round ended
  roundWinnerId?: string;
  roundLoserId?: string;
  caughtDroppingPlayerId?: string; // If a player was caught dropping
  handScores?: { [userId: string]: number }; // Stores final hand scores for all players at round end
  placements?: IPlacement[];
  payouts?: { [userId: string]: number };
  roundEntryApplied?: boolean;
  roundSettlementStatus?: 'pending' | 'settled' | 'failed';
  roundSettlementError?: string | null;
  roundSettledAt?: number | null;
  roundSettlementReference?: string | null;
  roundReadyPlayerIds?: string[];
  roundReadyDeadline?: number | null;
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

const CARD_RANK_ORDER: CardRank[] = ['Ace', '2', '3', '4', '5', '6', '7', 'Jack', 'Queen', 'King'];
const CARD_SUIT_ORDER: CardSuit[] = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];

const getCardNumericalRank = (rank: CardRank): number => CARD_RANK_ORDER.indexOf(rank);

const getCardSuitOrder = (suit: CardSuit): number => CARD_SUIT_ORDER.indexOf(suit);

const sortHandCards = (cards: Card[]): Card[] => {
  return [...cards].sort((a, b) => {
    const suitDiff = getCardSuitOrder(a.suit) - getCardSuitOrder(b.suit);
    if (suitDiff !== 0) return suitDiff;
    return getCardNumericalRank(a.rank) - getCardNumericalRank(b.rank);
  });
};

const sortSpreadCards = (cards: Card[]): Card[] => {
  if (cards.length <= 1) return [...cards];

  const allSameRank = cards.every((card) => card.rank === cards[0].rank);
  if (allSameRank) {
    return [...cards].sort((a, b) => getCardSuitOrder(a.suit) - getCardSuitOrder(b.suit));
  }

  const allSameSuit = cards.every((card) => card.suit === cards[0].suit);
  if (allSameSuit) {
    return [...cards].sort((a, b) => getCardNumericalRank(a.rank) - getCardNumericalRank(b.rank));
  }

  return sortHandCards(cards);
};

const getLowestScoreWinnerId = (
  players: Array<{ userId: string; hand: Card[] }>
): { winnerId: string; lowestScore: number } => {
  let lowestScore = Infinity;
  let winnerId = "";

  for (const player of players) {
    const score = calculateHandValue(player.hand);
    if (score < lowestScore) {
      lowestScore = score;
      winnerId = player.userId;
    }
  }

  return { winnerId, lowestScore };
};

/**
 * Checks for automatic opening wins after dealing.
 * Only 11 and under is instant; 41 must be declared at start of player's turn.
 * @param players The players in the game with their dealt hands.
 * @returns The userId of the winning player and win type, or null if no auto-win.
 */
export const checkForAutomaticWins = (players: Array<{ userId: string; hand: Card[] }>): { winnerId: string; type: 'AUTO_TRIPLE' } | null => {
  const eligiblePlayers = players
    .map((player) => ({ userId: player.userId, handValue: calculateHandValue(player.hand) }))
    .filter((player) => player.handValue <= 11)
    .sort((a, b) => a.handValue - b.handValue);

  if (eligiblePlayers.length === 0) {
    return null;
  }

  return {
    winnerId: eligiblePlayers[0].userId,
    type: 'AUTO_TRIPLE',
  };
};

/**
 * Handles the buy-in for all players in a round.
 * This only updates in-memory game-state ante/pot metadata.
 * @param gameState The current game state.
 * @returns The updated game state with round entry values initialized.
 */
export const handleBuyIn = async (gameState: IGameState): Promise<IGameState> => {
  let updatedPot = 0;
  const updatedLockedAntes: { [userId: string]: number } = {};
  const updatedPlayers = gameState.players.map((player) => {
    // Keep gameplay state deterministic; economy settlement happens outside the engine.
    updatedPot += gameState.baseStake;
    updatedLockedAntes[player.userId] = gameState.baseStake;
    
    return { ...player, currentBuyIn: gameState.baseStake };
  });

  return {
    ...gameState,
    players: updatedPlayers,
    pot: updatedPot,
    lockedAntes: updatedLockedAntes,
    roundEntryApplied: false,
    roundSettlementStatus: undefined,
    roundSettlementError: null,
    roundSettledAt: null,
    roundSettlementReference: null,
  };
};

export const buildPlacements = (gameState: IGameState): IPlacement[] => {
  const handScores = gameState.handScores ?? calculateAllHandScores(gameState.players);
  const winnerId = gameState.roundWinnerId;

  const ranked = [...gameState.players].sort((a, b) => {
    if (winnerId && a.userId === winnerId) return -1;
    if (winnerId && b.userId === winnerId) return 1;
    const scoreA = handScores[a.userId] ?? calculateHandValue(a.hand);
    const scoreB = handScores[b.userId] ?? calculateHandValue(b.hand);
    return scoreA - scoreB;
  });

  return ranked.map((player, index) => ({
    userId: player.userId,
    rank: index + 1,
    winType: player.userId === winnerId
      ? ((gameState.roundEndedBy ?? 'REGULAR') as RoundEndType)
      : 'LOSS',
  }));
};

export const finalizeRoundState = (gameState: IGameState): IGameState => {
  if (gameState.status !== 'round-end') {
    return gameState;
  }

  const handScores = gameState.handScores ?? calculateAllHandScores(gameState.players);
  const placements = gameState.placements ?? buildPlacements({ ...gameState, handScores });
  const existingSettlementStatus = gameState.roundSettlementStatus;

  return {
    ...gameState,
    handScores,
    placements,
    roundSettlementStatus: existingSettlementStatus ?? 'pending',
    roundSettlementError: gameState.roundSettlementError ?? null,
    roundSettledAt: gameState.roundSettledAt ?? null,
    roundSettlementReference: gameState.roundSettlementReference ?? null,
  };
};

export const toEngineRoundResult = (gameState: IGameState): IEngineRoundResult | null => {
  if (gameState.status !== 'round-end') {
    return null;
  }

  const finalized = finalizeRoundState(gameState);
  const placements = finalized.placements ?? [];
  if (placements.length === 0) {
    return null;
  }

  return {
    sessionId:
      finalized.contestId ??
      finalized.roundSettlementReference ??
      `${finalized.tableId}:${finalized.turn}`,
    mode: finalized.mode ?? DEFAULT_GAME_MODE,
    placements: placements.map((placement) => ({
      userId: placement.userId,
      rank: placement.rank,
      winType: placement.winType,
    })),
  };
};

const normalizeTurnTrackingState = (gameState: IGameState): IGameState => {
  const turnDurationMs = gameState.turnDurationMs ?? DEFAULT_TURN_DURATION_MS;
  const turnStartTime = gameState.turnStartTime ?? Date.now();
  const turnExpiresAt = gameState.turnExpiresAt ?? (turnStartTime + turnDurationMs);
  const players = gameState.players.map((player) => ({
    ...player,
    hand: sortHandCards(player.hand),
    spreads: player.spreads.map(sortSpreadCards),
    hasDrawnThisTurn: player.hasDrawnThisTurn ?? !!player.hasTakenActionThisTurn,
    hasDiscardedThisTurn: player.hasDiscardedThisTurn ?? false,
    hasDrawnAnyCard: player.hasDrawnAnyCard ?? false,
    startingHandValue: player.startingHandValue ?? calculateHandValue(player.hand),
    lastHitAppliedOnTurn: player.lastHitAppliedOnTurn ?? null,
    restrictedDiscardCard: player.restrictedDiscardCard ?? null,
  }));

  return {
    ...gameState,
    status: gameState.status === 'starting' ? 'in-progress' : gameState.status,
    players,
    turnDurationMs,
    turnStartTime,
    turnExpiresAt,
  };
};

const assertActiveTurnAction = (
  gameState: IGameState,
  playerIndex: number,
  userId: string,
  actionLabel: string
) => {
  if (gameState.status === 'round-end' || gameState.status === 'game-end' || gameState.status === 'waiting') {
    throw new Error(`Cannot ${actionLabel} because the round is not active.`);
  }

  if (gameState.currentPlayerIndex !== playerIndex) {
    throw new Error(`It is not player ${userId}'s turn to ${actionLabel}.`);
  }
};

/**
 * Initializes a new game for a given table.
 * @param table The table to start the game on.
 * @param players The players participating in the game.
 * @returns The initial game state.
 */
export const initializeGame = async (
  table: TableDocument,
  players: Array<{ userId: string; username: string; isAI: boolean; avatarUrl?: string }>,
  options?: { dealerIndex?: number }
): Promise<IGameState> => {
  const fullDeck = createDeck();
  const shuffledDeck = shuffleDeck(fullDeck);
  const { remainingDeck: dealtDeck, playerHands } = dealCards(shuffledDeck, players.length, 5);
  const remainingDeck = [...dealtDeck];

  const initialPlayersState = players.map((player, index) => {
    const hand = sortHandCards(playerHands[index]);
    return {
      userId: player.userId.toString(),
      username: player.username,
      avatarUrl: player.avatarUrl,
      hand,
      isAI: player.isAI,
      isHitLocked: false,
      hitLockCounter: 0,
      spreads: [],
      hasTakenActionThisTurn: false,
      hasDrawnThisTurn: false,
      hasDiscardedThisTurn: false,
      hasDrawnAnyCard: false,
      startingHandValue: calculateHandValue(hand),
      lastHitAppliedOnTurn: null,
      currentBuyIn: 0, // Initial buy-in is 0, handled by handleBuyIn
      restrictedDiscardCard: null,
    };
  });

  const dealerIndex = options?.dealerIndex !== undefined
    ? ((options.dealerIndex % players.length) + players.length) % players.length
    : 0;
  const firstTurnPlayerIndex = players.length > 0 ? (dealerIndex + 1) % players.length : 0;
  const resolvedBaseStake = resolveStakeAmountForMode(table.stake, table.mode);
  const turnStartTime = Date.now();

  let initialGameState: IGameState = {
    tableId: table._id.toString(),
    mode: table.mode,
    contestId: table.activeContestId ?? null,
    currentDealerIndex: dealerIndex, // Rotates clockwise between rounds
    players: initialPlayersState,
    deck: remainingDeck,
    discardPile: [],
    turn: 1,
    currentPlayerIndex: firstTurnPlayerIndex, // Start with player clockwise from dealer
    turnStartTime,
    turnDurationMs: DEFAULT_TURN_DURATION_MS,
    turnExpiresAt: turnStartTime + DEFAULT_TURN_DURATION_MS,
    lastAction: null,
    status: 'in-progress',
    baseStake: resolvedBaseStake,
    roundWins: {}, // Track round wins for each player
    pot: 0, // Initialize pot to 0
    lockedAntes: {},
    roundEndedBy: null,
    roundReadyPlayerIds: [],
    roundReadyDeadline: null,
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
      return finalizeRoundState(finalGameState);
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
  if (!gameStateString) {
    return null;
  }
  return normalizeTurnTrackingState(JSON.parse(gameStateString) as IGameState);
};

/**
 * Advances the game to the next player's turn.
 * @param gameState The current game state.
 * @returns The updated game state.
 */
export const nextTurn = (gameState: IGameState): IGameState => {
  const endedTurnPlayerIndex = gameState.currentPlayerIndex;
  const nextPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
  const turnDurationMs = gameState.turnDurationMs ?? DEFAULT_TURN_DURATION_MS;
  const turnStartTime = Date.now();
  const updatedPlayers = gameState.players.map((player, index) => {
    const decrementedLockCounter = index === endedTurnPlayerIndex
      ? Math.max(0, player.hitLockCounter - 1)
      : player.hitLockCounter;

    return {
      ...player,
      hasTakenActionThisTurn: false, // Reset for new turn
      hasDrawnThisTurn: false,
      hasDiscardedThisTurn: false,
      hitLockCounter: decrementedLockCounter,
      isHitLocked: decrementedLockCounter > 0,
      restrictedDiscardCard: null,
    };
  });

  return {
    ...gameState,
    status: 'in-progress',
    currentPlayerIndex: nextPlayerIndex,
    turn: gameState.turn + 1,
    turnStartTime,
    turnDurationMs,
    turnExpiresAt: turnStartTime + turnDurationMs,
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
  gameState = normalizeTurnTrackingState(gameState);
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  assertActiveTurnAction(gameState, playerIndex, userId, 'draw');
  const player = gameState.players[playerIndex];
  if (player.hasDrawnThisTurn) {
    throw new Error('You already drew this turn.');
  }
  if (player.hasDiscardedThisTurn) {
    throw new Error('You already discarded this turn.');
  }

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
    const { winnerId, lowestScore } = getLowestScoreWinnerId(gameState.players);

    const updatedGameState: IGameState = {
        ...gameState,
        status: 'round-end',
        roundEndedBy: 'DECK_EMPTY',
        roundWinnerId: winnerId,
        lastAction: { type: 'deckEmpty', payload: { winnerId, lowestScore } as any, timestamp: Date.now() },
        handScores: calculateAllHandScores(gameState.players),
    };
    
    return finalizeRoundState(updatedGameState);
  }

  newHand.push(drawnCard);
  const sortedHand = sortHandCards(newHand);

  const updatedPlayers = [...gameState.players];
  updatedPlayers[playerIndex] = {
    ...player,
    hand: sortedHand,
    hasTakenActionThisTurn: true,
    hasDrawnThisTurn: true,
    hasDiscardedThisTurn: false,
    hasDrawnAnyCard: true,
    restrictedDiscardCard: restrictedDiscardCard
  };

  if (source === 'deck' && newDeck.length === 0) {
    const { winnerId, lowestScore } = getLowestScoreWinnerId(updatedPlayers);
    const roundEndState: IGameState = {
      ...gameState,
      status: 'round-end',
      deck: newDeck,
      discardPile: newDiscardPile,
      players: updatedPlayers,
      roundEndedBy: 'DECK_EMPTY',
      roundWinnerId: winnerId,
      lastAction: {
        type: 'deckEmpty',
        payload: { winnerId, lowestScore, exhaustedOnDraw: true } as any,
        timestamp: Date.now(),
      },
      handScores: calculateAllHandScores(updatedPlayers),
    };
    return finalizeRoundState(roundEndState);
  }

  return {
    ...gameState,
    status: 'in-progress',
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
export const playerDiscardCard = async (gameState: IGameState, userId: string, cardToDiscard: Card): Promise<IGameState> => {
  gameState = normalizeTurnTrackingState(gameState);
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  assertActiveTurnAction(gameState, playerIndex, userId, 'discard');
  const player = gameState.players[playerIndex];
  if (!player.hasDrawnThisTurn) {
    throw new Error('You must draw before discarding.');
  }
  if (player.hasDiscardedThisTurn) {
    throw new Error('You already discarded this turn.');
  }
  const newHand = [...player.hand];
  const mandatorySpread = findFirstMandatorySpread(player.hand);
  if (mandatorySpread) {
    throw new Error('You must play available spreads before discarding. Only all-Ace spreads may be held.');
  }

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
  updatedPlayers[playerIndex] = {
    ...player,
    hand: sortHandCards(newHand),
    hasTakenActionThisTurn: true,
    hasDiscardedThisTurn: true,
    restrictedDiscardCard: null,
  };

  const newDiscardPile = [...gameState.discardPile, cardToDiscard];

  const updatedGameState: IGameState = {
    ...gameState,
    status: 'in-progress',
    players: updatedPlayers,
    discardPile: newDiscardPile,
    lastAction: { type: 'discardCard', payload: { userId, card: cardToDiscard } as any, timestamp: Date.now() },
  };

  if (newHand.length === 0) {
    const roundEndState: IGameState = {
      ...updatedGameState,
      status: 'round-end',
      roundEndedBy: 'REGULAR',
      roundWinnerId: userId,
      handScores: calculateAllHandScores(updatedGameState.players),
    };
    return finalizeRoundState(roundEndState);
  }

  return updatedGameState;
};

const isAceOnlySpread = (cards: Card[]): boolean => cards.every((card) => card.rank === 'Ace');

const findFirstSpreadInHand = (
  hand: Card[],
  predicate: (cards: Card[]) => boolean
): Card[] | null => {
  if (hand.length < 3) {
    return null;
  }

  const combination: Card[] = [];
  const search = (startIndex: number, targetSize: number): Card[] | null => {
    if (combination.length === targetSize) {
      if (isValidSpread(combination) && predicate(combination)) {
        return [...combination];
      }
      return null;
    }

    for (let index = startIndex; index < hand.length; index++) {
      combination.push(hand[index]);
      const found = search(index + 1, targetSize);
      combination.pop();
      if (found) {
        return found;
      }
    }

    return null;
  };

  for (let spreadSize = 3; spreadSize <= hand.length; spreadSize++) {
    const found = search(0, spreadSize);
    if (found) {
      return found;
    }
  }

  return null;
};

export const findFirstMandatorySpread = (hand: Card[]): Card[] | null => {
  return findFirstSpreadInHand(hand, (cards) => !isAceOnlySpread(cards));
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
  return player.hand.length === 0;
};

/**
 * Handles a player spreading cards.
 * @param gameState The current game state.
 * @param userId The ID of the player spreading the cards.
 * @param cardsToSpread The array of cards to spread.
 * @returns The updated game state.
 */
export const playerSpreadCards = async (gameState: IGameState, userId: string, cardsToSpread: Card[]): Promise<IGameState> => {
  gameState = normalizeTurnTrackingState(gameState);
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  assertActiveTurnAction(gameState, playerIndex, userId, 'spread');
  const player = gameState.players[playerIndex];
  if (!player.hasDrawnThisTurn) {
    throw new Error('You must draw before spreading.');
  }
  if (player.hasDiscardedThisTurn) {
    throw new Error('Turn already ended for this player.');
  }
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
  const sortedSpread = sortSpreadCards(cardsToSpread);
  newSpreads.push(sortedSpread);

  // 5. Update player's spread count for the turn
  const updatedPlayer = {
    ...player,
    hand: sortHandCards(newHand),
    spreads: newSpreads,
    hasTakenActionThisTurn: true,
  };

  const updatedPlayers = [...gameState.players];
  updatedPlayers[playerIndex] = updatedPlayer;

  let updatedGameState: IGameState = { // Explicitly type updatedGameState
    ...gameState,
    status: 'in-progress',
    players: updatedPlayers,
    lastAction: { type: 'spread', payload: { userId, cards: sortedSpread } as any, timestamp: Date.now() },
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
    updatedGameState = finalizeRoundState(updatedGameState);
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
  gameState = normalizeTurnTrackingState(gameState);
  const hittingPlayerIndex = gameState.players.findIndex(p => p.userId === hittingPlayerId);
  if (hittingPlayerIndex === -1) {
    throw new Error(`Hitting player ${hittingPlayerId} not found.`);
  }
  if (hittingPlayerId === targetPlayerId) {
    throw new Error('You can only hit another player\'s spread.');
  }
  assertActiveTurnAction(gameState, hittingPlayerIndex, hittingPlayerId, 'hit');
  const hittingPlayer = gameState.players[hittingPlayerIndex];
  if (!hittingPlayer.hasDrawnThisTurn) {
    throw new Error('You must draw before hitting.');
  }
  if (hittingPlayer.hasDiscardedThisTurn) {
    throw new Error('Turn already ended for this player.');
  }

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
  const [playedCard] = updatedHittingHand.splice(cardInHandIndex, 1);
  if (!playedCard) {
    throw new Error(`Unable to remove card ${cardToHitWith.rank} of ${cardToHitWith.suit} from player ${hittingPlayerId}'s hand.`);
  }

  // Add card to target spread
  const updatedTargetSpread = sortSpreadCards([...targetSpread, playedCard]);
  const updatedTargetPlayerSpreads = [...targetPlayer.spreads];
  updatedTargetPlayerSpreads[targetSpreadIndex] = updatedTargetSpread;

  const alreadyHitThisTurn = targetPlayer.lastHitAppliedOnTurn === gameState.turn;
  const lockIncrease = alreadyHitThisTurn
    ? 0
    : (targetPlayer.hitLockCounter > 0 ? 1 : 2);
  const updatedTargetLockCounter = targetPlayer.hitLockCounter + lockIncrease;

  const updatedPlayers = [...gameState.players];
  targetPlayer = {
    ...targetPlayer,
    spreads: updatedTargetPlayerSpreads,
    isHitLocked: updatedTargetLockCounter > 0,
    hitLockCounter: updatedTargetLockCounter,
    lastHitAppliedOnTurn: gameState.turn,
  };

  const updatedHittingPlayer = { ...hittingPlayer, hand: sortHandCards(updatedHittingHand), hasTakenActionThisTurn: true };
  updatedPlayers[hittingPlayerIndex] = updatedHittingPlayer;
  updatedPlayers[targetPlayerIndex] = targetPlayer;

  const updatedGameState: IGameState = {
    ...gameState,
    status: 'in-progress',
    players: updatedPlayers,
    lastAction: { type: 'hit', payload: { hittingPlayerId, card: playedCard, targetPlayerId, targetSpreadIndex } as any, timestamp: Date.now() },
  };

  if (updatedHittingHand.length === 0) {
    const roundEndState: IGameState = {
      ...updatedGameState,
      status: 'round-end',
      roundEndedBy: 'REEM',
      roundWinnerId: hittingPlayerId,
      handScores: calculateAllHandScores(updatedPlayers),
    };
    return finalizeRoundState(roundEndState);
  }

  return updatedGameState;
};

/**
 * Handles a player dropping.
 * @param gameState The current game state.
 * @param userId The ID of the player dropping.
 * @returns The updated game state (round ended).
 */
export const playerDrop = async (gameState: IGameState, userId: string): Promise<IGameState> => {
  gameState = normalizeTurnTrackingState(gameState);
  const playerIndex = gameState.players.findIndex(p => p.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  assertActiveTurnAction(gameState, playerIndex, userId, 'drop');
  const player = gameState.players[playerIndex];

  // 1. Validate drop conditions
  if (player.hasDrawnThisTurn || player.hasTakenActionThisTurn) {
    throw new Error(`Player ${userId} cannot drop after taking an action this turn.`);
  }
  if (player.hitLockCounter > 0 || player.isHitLocked) {
    throw new Error(`Player ${userId} cannot drop while hit-locked.`);
  }

  const handScores = calculateAllHandScores(gameState.players);
  const dropperScore = handScores[userId];
  const lowestOpponent = gameState.players
    .filter((candidate) => candidate.userId !== userId)
    .sort((a, b) => (handScores[a.userId] ?? Infinity) - (handScores[b.userId] ?? Infinity))[0];

  if (dropperScore === undefined || !lowestOpponent) {
    throw new Error('Unable to resolve drop outcome.');
  }

  const lowestOpponentScore = handScores[lowestOpponent.userId] ?? Infinity;
  const isCaughtDrop = lowestOpponentScore <= dropperScore;
  const winnerId = isCaughtDrop ? lowestOpponent.userId : userId;

  // Acknowledge drop and end the round
  let updatedGameState: IGameState = {
    ...gameState,
    status: 'round-end',
    lastAction: {
      type: 'drop',
      payload: {
        userId,
        handValue: dropperScore,
        winnerId,
        lowestScore: Math.min(dropperScore, lowestOpponentScore),
        caught: isCaughtDrop,
      } as any,
      timestamp: Date.now(),
    },
    roundEndedBy: isCaughtDrop ? 'CAUGHT_DROP' : 'REGULAR',
    roundWinnerId: winnerId,
    caughtDroppingPlayerId: isCaughtDrop ? userId : undefined,
    handScores,
  };

  updatedGameState = finalizeRoundState(updatedGameState);
  return updatedGameState;
};

export const playerDeclare41 = async (gameState: IGameState, userId: string): Promise<IGameState> => {
  gameState = normalizeTurnTrackingState(gameState);
  const playerIndex = gameState.players.findIndex((player) => player.userId === userId);
  if (playerIndex === -1) {
    throw new Error(`Player ${userId} not found.`);
  }

  assertActiveTurnAction(gameState, playerIndex, userId, 'declare 41');
  const player = gameState.players[playerIndex];

  if (player.hasDrawnThisTurn || player.hasTakenActionThisTurn || player.hasDiscardedThisTurn) {
    throw new Error('41 can only be declared at the start of your turn before drawing.');
  }

  if (player.hasDrawnAnyCard) {
    throw new Error('41 can only be declared before you draw your first card of the round.');
  }

  if (player.startingHandValue !== 41 || calculateHandValue(player.hand) !== 41) {
    throw new Error('Your starting hand is not exactly 41.');
  }

  const updatedGameState: IGameState = {
    ...gameState,
    status: 'round-end',
    roundEndedBy: 'AUTO_TRIPLE',
    roundWinnerId: userId,
    lastAction: { type: 'declare41', payload: { userId } as any, timestamp: Date.now() },
    handScores: calculateAllHandScores(gameState.players),
  };

  return finalizeRoundState(updatedGameState);
};
