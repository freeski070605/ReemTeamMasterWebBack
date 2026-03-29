import { IGameState, calculateHandValue, canHitSpread, isValidSpread } from './gameEngine';
import { Card, CardRank } from './deck';

interface AIPlayerAction {
  type: 'draw' | 'discard' | 'spread' | 'hit' | 'drop' | 'declare41' | 'none';
  payload?: any;
}

interface AISpreadChoice {
  cards: Card[];
  score: number;
}

interface AIHitChoice {
  card: Card;
  targetPlayerId: string;
  targetSpreadIndex: number;
  score: number;
}

const RANK_ORDER: CardRank[] = ['Ace', '2', '3', '4', '5', '6', '7', 'Jack', 'Queen', 'King'];
const DISCARD_PICKUP_MARGIN = 14;

const getCardId = (card: Card): string => `${card.rank}-${card.suit}`;

const getRankIndex = (rank: CardRank): number => RANK_ORDER.indexOf(rank);

const isSameCard = (left: Card, right: Card): boolean =>
  left.rank === right.rank && left.suit === right.suit;

const isAceOnlySpread = (cards: Card[]): boolean => cards.every((card) => card.rank === 'Ace');

const sumCardValues = (cards: Card[]): number =>
  cards.reduce((total, card) => total + card.value, 0);

const removeCardsFromHand = (hand: Card[], cardsToRemove: Card[]): Card[] => {
  const remaining = [...hand];

  for (const card of cardsToRemove) {
    const index = remaining.findIndex((candidate) => isSameCard(candidate, card));
    if (index !== -1) {
      remaining.splice(index, 1);
    }
  }

  return remaining;
};

const buildSpreadKey = (cards: Card[]): string =>
  [...cards]
    .map(getCardId)
    .sort()
    .join('|');

const findPossibleSpreads = (hand: Card[]): Card[][] => {
  if (hand.length < 3) {
    return [];
  }

  const possibleSpreads: Card[][] = [];
  const seen = new Set<string>();
  const combination: Card[] = [];

  const search = (startIndex: number, targetSize: number) => {
    if (combination.length === targetSize) {
      if (!isValidSpread(combination)) {
        return;
      }

      const key = buildSpreadKey(combination);
      if (!seen.has(key)) {
        seen.add(key);
        possibleSpreads.push([...combination]);
      }
      return;
    }

    for (let index = startIndex; index < hand.length; index++) {
      combination.push(hand[index]);
      search(index + 1, targetSize);
      combination.pop();
    }
  };

  for (let targetSize = 3; targetSize <= hand.length; targetSize++) {
    search(0, targetSize);
  }

  return possibleSpreads;
};

const countSpreadsContainingCard = (hand: Card[], targetCard: Card): number =>
  findPossibleSpreads(hand).filter((spread) => spread.some((card) => isSameCard(card, targetCard))).length;

const cardCanHitAnySpread = (gameState: IGameState, aiPlayerId: string, card: Card): boolean =>
  gameState.players.some((player) =>
    player.spreads.some((spread) => {
      if (player.userId === aiPlayerId && spread.some((spreadCard) => isSameCard(spreadCard, card))) {
        return false;
      }

      return canHitSpread(spread, card);
    })
  );

const getRunSupportScore = (hand: Card[], targetCard: Card): number => {
  const targetRankIndex = getRankIndex(targetCard.rank);
  let score = 0;

  const hasExactLeft = hand.some(
    (card) =>
      !isSameCard(card, targetCard) &&
      card.suit === targetCard.suit &&
      getRankIndex(card.rank) === targetRankIndex - 1
  );
  const hasExactRight = hand.some(
    (card) =>
      !isSameCard(card, targetCard) &&
      card.suit === targetCard.suit &&
      getRankIndex(card.rank) === targetRankIndex + 1
  );
  const hasGapLeft = hand.some(
    (card) =>
      !isSameCard(card, targetCard) &&
      card.suit === targetCard.suit &&
      getRankIndex(card.rank) === targetRankIndex - 2
  );
  const hasGapRight = hand.some(
    (card) =>
      !isSameCard(card, targetCard) &&
      card.suit === targetCard.suit &&
      getRankIndex(card.rank) === targetRankIndex + 2
  );

  if (hasExactLeft) score += 14;
  if (hasExactRight) score += 14;
  if (hasGapLeft) score += 6;
  if (hasGapRight) score += 6;

  return score;
};

const getCardKeepScore = (
  gameState: IGameState,
  aiPlayerId: string,
  hand: Card[],
  card: Card
): number => {
  const sameRankCount = hand.filter(
    (candidate) => !isSameCard(candidate, card) && candidate.rank === card.rank
  ).length;
  const spreadCount = countSpreadsContainingCard(hand, card);
  const runSupport = getRunSupportScore(hand, card);
  const canHitNow = cardCanHitAnySpread(gameState, aiPlayerId, card);
  const lowValueBonus = card.value <= 3 ? 8 : card.value <= 5 ? 3 : 0;

  return (
    spreadCount * 42 +
    sameRankCount * 16 +
    runSupport +
    (canHitNow ? 12 : 0) +
    lowValueBonus -
    card.value * 4
  );
};

const chooseDiscardCard = (
  gameState: IGameState,
  aiPlayerId: string,
  hand: Card[],
  restrictedCardId: string | null
): Card | null => {
  const discardableCards = hand.filter((card) => {
    const id = getCardId(card);
    return restrictedCardId === null || id !== restrictedCardId;
  });

  const source = discardableCards.length > 0 ? discardableCards : hand;
  if (source.length === 0) {
    return null;
  }

  return [...source].sort((left, right) => {
    const leftKeep = getCardKeepScore(gameState, aiPlayerId, hand, left);
    const rightKeep = getCardKeepScore(gameState, aiPlayerId, hand, right);

    if (leftKeep !== rightKeep) {
      return leftKeep - rightKeep;
    }

    if (left.value !== right.value) {
      return right.value - left.value;
    }

    return getCardId(left).localeCompare(getCardId(right));
  })[0];
};

const chooseBestSpread = (gameState: IGameState, aiPlayerId: string, hand: Card[]): AISpreadChoice | null => {
  const possibleSpreads = findPossibleSpreads(hand);
  if (possibleSpreads.length === 0) {
    return null;
  }

  const spreadChoices = possibleSpreads.map((cards) => {
    const remainingHand = removeCardsFromHand(hand, cards);
    const followUpSpreads = findPossibleSpreads(remainingHand).length;
    const removedValue = sumCardValues(cards);
    const isMandatory = !isAceOnlySpread(cards);
    let score = cards.length * 40 + removedValue * 6 + followUpSpreads * 15 - calculateHandValue(remainingHand);

    if (isMandatory) {
      score += 12;
    }

    if (remainingHand.length === 0) {
      score += 10000;
    } else if (remainingHand.length === 1) {
      const followUpHit = chooseBestHit(gameState, aiPlayerId, remainingHand);
      if (followUpHit) {
        score += 120;
      }
    }

    return { cards, score };
  });

  spreadChoices.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    if (left.cards.length !== right.cards.length) {
      return right.cards.length - left.cards.length;
    }

    return sumCardValues(right.cards) - sumCardValues(left.cards);
  });

  return spreadChoices[0] ?? null;
};

const chooseBestHit = (gameState: IGameState, aiPlayerId: string, hand: Card[]): AIHitChoice | null => {
  if (hand.length === 0) {
    return null;
  }

  const aiPlayer = gameState.players.find((player) => player.userId === aiPlayerId);
  if (!aiPlayer) {
    return null;
  }

  const hitChoices: AIHitChoice[] = [];

  for (const card of hand) {
    for (const player of gameState.players) {
      player.spreads.forEach((spread, targetSpreadIndex) => {
        if (!canHitSpread(spread, card)) {
          return;
        }

        if (player.userId === aiPlayerId && spread.some((spreadCard) => isSameCard(spreadCard, card))) {
          return;
        }

        const remainingHand = removeCardsFromHand(hand, [card]);
        const hittingOpponent = player.userId !== aiPlayerId;
        const alreadyHitThisTurn = player.lastHitAppliedOnTurn === gameState.turn;
        const lockIncrease = hittingOpponent
          ? (alreadyHitThisTurn ? 0 : player.hitLockCounter > 0 ? 1 : 2)
          : 0;
        const targetHandValue = calculateHandValue(player.hand);

        let score = card.value * 8 - calculateHandValue(remainingHand);

        if (remainingHand.length === 0) {
          score += 10000;
        }

        if (hittingOpponent) {
          score += lockIncrease * 22;
          score += Math.max(0, 12 - targetHandValue) * 4;
          if (!player.isHitLocked && targetHandValue <= 8) {
            score += 20;
          }
        } else {
          score += 8;
        }

        if (findPossibleSpreads(remainingHand).length > 0) {
          score += 10;
        }

        hitChoices.push({
          card,
          targetPlayerId: player.userId,
          targetSpreadIndex,
          score,
        });
      });
    }
  }

  hitChoices.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    if (left.card.value !== right.card.value) {
      return right.card.value - left.card.value;
    }

    return getCardId(left.card).localeCompare(getCardId(right.card));
  });

  return hitChoices[0] ?? null;
};

const hasMandatorySpreadInHand = (hand: Card[]): boolean =>
  findPossibleSpreads(hand).some((spread) => !isAceOnlySpread(spread));

const canSafelyDrop = (gameState: IGameState, aiPlayerId: string): boolean => {
  const aiPlayer = gameState.players.find((player) => player.userId === aiPlayerId);
  if (!aiPlayer || aiPlayer.isHitLocked || aiPlayer.hitLockCounter > 0) {
    return false;
  }

  if (hasMandatorySpreadInHand(aiPlayer.hand)) {
    return false;
  }

  const aiHandValue = calculateHandValue(aiPlayer.hand);
  const lowestOpponentScore = gameState.players
    .filter((player) => player.userId !== aiPlayerId)
    .reduce((lowest, player) => Math.min(lowest, calculateHandValue(player.hand)), Number.POSITIVE_INFINITY);

  return aiHandValue < lowestOpponentScore;
};

const shouldDrawFromDiscard = (gameState: IGameState, aiPlayerId: string, hand: Card[]): boolean => {
  const topDiscard = gameState.discardPile[gameState.discardPile.length - 1];
  if (!topDiscard) {
    return false;
  }

  const simulatedHand = [...hand, topDiscard];
  const spreadChoice = chooseBestSpread(gameState, aiPlayerId, simulatedHand);
  if (spreadChoice && spreadChoice.cards.some((card) => isSameCard(card, topDiscard))) {
    return true;
  }

  const hitChoice = chooseBestHit(gameState, aiPlayerId, simulatedHand);
  if (hitChoice && isSameCard(hitChoice.card, topDiscard)) {
    return true;
  }

  const currentDiscardCandidate = chooseDiscardCard(gameState, aiPlayerId, hand, null);
  if (!currentDiscardCandidate) {
    return topDiscard.value <= 4;
  }

  const topKeepScore = getCardKeepScore(gameState, aiPlayerId, simulatedHand, topDiscard);
  const currentDiscardKeepScore = getCardKeepScore(gameState, aiPlayerId, hand, currentDiscardCandidate);

  return (
    topKeepScore >= currentDiscardKeepScore + DISCARD_PICKUP_MARGIN &&
    topDiscard.value <= currentDiscardCandidate.value
  );
};

export const getAIPlayerAction = (gameState: IGameState, aiPlayerId: string): AIPlayerAction => {
  console.log(`[DEBUG] getAIPlayerAction called for ${aiPlayerId}. Current Turn Index: ${gameState.currentPlayerIndex}`);
  const aiPlayer = gameState.players.find((player) => player.userId === aiPlayerId);
  const currentPlayer = gameState.players[gameState.currentPlayerIndex];

  if (!aiPlayer || !currentPlayer || currentPlayer.userId !== aiPlayerId) {
    return { type: 'none' };
  }

  const aiHand = aiPlayer.hand;
  const hasDrawnThisTurn = aiPlayer.hasDrawnThisTurn ?? !!aiPlayer.hasTakenActionThisTurn;
  const hasDiscardedThisTurn = aiPlayer.hasDiscardedThisTurn ?? false;

  if (!hasDrawnThisTurn) {
    if (!aiPlayer.hasDrawnAnyCard && aiPlayer.startingHandValue === 41 && calculateHandValue(aiHand) === 41) {
      return { type: 'declare41' };
    }

    if (canSafelyDrop(gameState, aiPlayerId)) {
      return { type: 'drop' };
    }

    if (shouldDrawFromDiscard(gameState, aiPlayerId, aiHand)) {
      return { type: 'draw', payload: { source: 'discard' } };
    }

    return { type: 'draw', payload: { source: 'deck' } };
  }

  if (hasDiscardedThisTurn) {
    return { type: 'none' };
  }

  const spreadChoice = chooseBestSpread(gameState, aiPlayerId, aiHand);
  if (spreadChoice) {
    return { type: 'spread', payload: { cards: spreadChoice.cards } };
  }

  const hitChoice = chooseBestHit(gameState, aiPlayerId, aiHand);
  if (hitChoice) {
    return {
      type: 'hit',
      payload: {
        card: hitChoice.card,
        targetPlayerId: hitChoice.targetPlayerId,
        targetSpreadIndex: hitChoice.targetSpreadIndex,
      },
    };
  }

  const restrictedCardId = aiPlayer.restrictedDiscardCard ?? null;
  const discardChoice = chooseDiscardCard(gameState, aiPlayerId, aiHand, restrictedCardId);
  if (discardChoice) {
    return { type: 'discard', payload: { card: discardChoice } };
  }

  return { type: 'none' };
};
