// Gift
export interface Gift {
  name: string;
  count: number;
}

// User (MongoDB)
export interface User {
  id: string;
  balance: number;
  gifts: Gift[];
}

// Winner в аукционе
export interface AuctionWinner {
  roundIndex: number;    // номер раунда
  place: number;         // место (1, 2, 3...)
  userId: string;
  stars: number;         // ставка на момент победы
  prize: number;         // сколько подарков получил
}

// Round в аукционе
export interface AuctionRound {
  duration: number;    // длительность раунда в секундах
  prizes: number[];    // подарки для каждого места [1st, 2nd, 3rd, ...]
}

// Состояния аукциона
export type AuctionState = 'pending' | 'active' | 'finished' | 'cancelled';

// Подарок в аукционе (приз)
export interface AuctionGift {
  name: string;
  count: number;
}

// Auction
export interface Auction {
  id: string;
  name: string;
  state: AuctionState;
  gift: AuctionGift;         // какой подарок разыгрывается
  startTime: number;         // timestamp начала
  currentRound: number;      // текущий раунд (0-based), -1 если не начался
  roundEndTime?: number;     // timestamp окончания текущего раунда (для anti-snipe)
  authorId: string;
  winners: AuctionWinner[];
  rounds: AuctionRound[];
}

// Данные для создания аукциона
export interface CreateAuctionInput {
  name: string;
  giftName: string;
  giftCount: number;
  startTime: number;         // когда начинаем
  rounds: AuctionRound[];    // план раундов
}
