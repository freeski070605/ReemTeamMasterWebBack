export type CardSuit = 'Hearts' | 'Diamonds' | 'Clubs' | 'Spades';
export type CardRank = 'Ace' | '2' | '3' | '4' | '5' | '6' | '7' | 'Jack' | 'Queen' | 'King';

export interface Card {
  suit: CardSuit;
  rank: CardRank;
  value: number;
}

const SUITS: CardSuit[] = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const RANKS_AND_VALUES: { rank: CardRank; value: number }[] = [
  { rank: 'Ace', value: 1 },
  { rank: '2', value: 2 },
  { rank: '3', value: 3 },
  { rank: '4', value: 4 },
  { rank: '5', value: 5 },
  { rank: '6', value: 6 },
  { rank: '7', value: 7 },
  { rank: 'Jack', value: 10 },
  { rank: 'Queen', value: 10 },
  { rank: 'King', value: 10 },
];

/**
 * Creates a new 40-card Tonk deck (52 cards minus 8s, 9s, 10s).
 * @returns An array of Card objects.
 */
export const createDeck = (): Card[] => {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const { rank, value } of RANKS_AND_VALUES) {
      deck.push({ suit, rank, value });
    }
  }
  return deck;
};

/**
 * Shuffles a deck of cards using the Fisher-Yates (Knuth) algorithm.
 * @param deck The deck of cards to shuffle.
 * @returns A new shuffled array of Card objects.
 */
export const shuffleDeck = (deck: Card[]): Card[] => {
  const shuffledDeck = [...deck];
  for (let i = shuffledDeck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledDeck[i], shuffledDeck[j]] = [shuffledDeck[j], shuffledDeck[i]];
  }
  return shuffledDeck;
};

/**
 * Deals cards to players from a shuffled deck.
 * @param shuffledDeck The shuffled deck of cards.
 * @param numberOfPlayers The number of players in the game (2-4).
 * @param cardsPerPlayer The number of cards to deal to each player (default 5).
 * @returns An object containing remaining deck and hands for each player.
 */
export const dealCards = (
  shuffledDeck: Card[],
  numberOfPlayers: number,
  cardsPerPlayer: number = 5
): { remainingDeck: Card[]; playerHands: Card[][] } => {
  if (numberOfPlayers < 2 || numberOfPlayers > 4) {
    throw new Error("Number of players must be between 2 and 4.");
  }
  if (shuffledDeck.length < numberOfPlayers * cardsPerPlayer) {
    throw new Error("Not enough cards in the deck to deal.");
  }

  const remainingDeck = [...shuffledDeck];
  const playerHands: Card[][] = Array.from({ length: numberOfPlayers }, () => []);

  for (let i = 0; i < cardsPerPlayer; i++) {
    for (let j = 0; j < numberOfPlayers; j++) {
      const card = remainingDeck.shift();
      if (card) {
        playerHands[j].push(card);
      } else {
        throw new Error("Unexpected: Ran out of cards during dealing.");
      }
    }
  }

  return { remainingDeck, playerHands };
};

// Example usage (for testing purposes, not part of the game logic flow)
// const newDeck = createDeck();
// const shuffled = shuffleDeck(newDeck);
// const { remainingDeck, playerHands } = dealCards(shuffled, 3);
// console.log("Player Hands:", playerHands);
// console.log("Remaining Deck:", remainingDeck.length);
