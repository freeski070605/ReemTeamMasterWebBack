import { IGameState, calculateHandValue, isValidSpread } from './gameEngine';
import { Card } from './deck';
import { CardRank, CardSuit } from './deck';

interface AIPlayerAction {
  type: 'draw' | 'discard' | 'spread' | 'hit' | 'drop' | 'none';
  payload?: any; // Specific data for the action
}

/**
 * Simulates an AI player's turn, deciding the best action based on current game state.
 * @param gameState The current game state.
 * @param aiPlayerId The userId of the AI player.
 * @returns The chosen AIPlayerAction.
 */
export const getAIPlayerAction = (gameState: IGameState, aiPlayerId: string): AIPlayerAction => {
  console.log(`[DEBUG] getAIPlayerAction called for ${aiPlayerId}. Current Turn Index: ${gameState.currentPlayerIndex}`);
  const aiPlayer = gameState.players.find(p => p.userId === aiPlayerId);
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];

  if (!aiPlayer || currentPlayer.userId !== aiPlayerId) {
    return { type: 'none' }; // Not AI's turn or player not found
  }

  const aiHand = aiPlayer.hand;

  // 1. Prioritize Reem (two spreads in one turn)
  // This requires a more complex lookahead, for now, let's just prioritize making one good spread if possible
  const possibleSpreads = findPossibleSpreads(aiHand);
  for (const spread of possibleSpreads) {
    // Simulate making this spread and then check if another spread is possible
    const remainingHandAfterFirstSpread = aiHand.filter(card => !spread.includes(card));
    const possibleSecondSpreads = findPossibleSpreads(remainingHandAfterFirstSpread);
    if (possibleSecondSpreads.length > 0) {
      return { type: 'spread', payload: { cards: spread } }; // Prioritize Reem
    }
  }

  // 2. Prioritize making a good spread if not Reem-ing
  if (possibleSpreads.length > 0) {
    // For simplicity, just take the first valid spread
    return { type: 'spread', payload: { cards: possibleSpreads[0] } };
  }

  // 3. Look for strategic Hits
  const allPlayerSpreads = gameState.players.flatMap(player => player.spreads);
  for (const cardInHand of aiHand) {
    for (const spread of allPlayerSpreads) {
      // This requires the 'canHitSpread' logic from gameEngine.ts
      // For now, let's assume a simplified check or pass
      // TODO: Integrate actual canHitSpread logic
      // if (canHitSpread(spread, cardInHand)) {
      //   return { type: 'hit', payload: { card: cardInHand, targetSpreadId: 'someId', targetPlayerId: 'somePlayerId' } };
      // }
    }
  }

  // 4. Decide whether to Drop (only if not hit-locked and no action taken)
  if (!aiPlayer.isHitLocked && !aiPlayer.hasTakenActionThisTurn) {
    const handValue = calculateHandValue(aiHand);
    // Simple AI: Drop if hand value is low (e.g., <= 5)
    if (handValue <= 5) {
      return { type: 'drop' };
    }
  }

  // 5. Draw a card if no other good moves and hasn't drawn yet
  // Also try to draw if deck is empty to trigger round end logic
  if (!aiPlayer.hasTakenActionThisTurn && gameState.deck.length >= 0) {
    return { type: 'draw' };
  }

  // 6. If nothing else, discard a random card (should always be possible after drawing)
  if (aiHand.length > 0) {
    const cardToDiscard = aiHand[Math.floor(Math.random() * aiHand.length)];
    return { type: 'discard', payload: { card: cardToDiscard } };
  }

  return { type: 'none' }; // Should not happen in a valid game flow
};

/**
 * Helper function to find all possible valid spreads a player can make from their hand.
 * @param hand The player's current hand.
 * @returns An array of arrays of Cards, where each inner array is a valid spread.
 */
const findPossibleSpreads = (hand: Card[]): Card[][] => {
  const possibleSpreads: Card[][] = [];
  // This is a simplified implementation. A real AI would try all combinations.

  // Generate all combinations of cards (at least 3)
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      for (let k = j + 1; k < hand.length; k++) {
        const combination = [hand[i], hand[j], hand[k]];
        if (isValidSpread(combination)) {
          possibleSpreads.push(combination);
        }
      }
    }
  }
  // Extend to 4, 5+ cards for more complex spreads
  // This part needs to be more robust to find all possible spreads from the hand

  return possibleSpreads;
};
