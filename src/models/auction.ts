import { Schema, model } from 'mongoose';
import { Auction, AuctionWinner, AuctionRound, AuctionGift } from '../types';

const AuctionWinnerSchema = new Schema<AuctionWinner>({
  roundIndex: { type: Number, required: true },
  place: { type: Number, required: true },
  userId: { type: String, required: true },
  stars: { type: Number, required: true },
  prize: { type: Number, required: true }
}, { _id: false });

const AuctionRoundSchema = new Schema<AuctionRound>({
  duration: { type: Number, required: true },
  prizes: { type: [Number], required: true }
}, { _id: false });

const AuctionGiftSchema = new Schema<AuctionGift>({
  name: { type: String, required: true },
  count: { type: Number, required: true }
}, { _id: false });

const AuctionSchema = new Schema<Auction>({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  state: { 
    type: String, 
    enum: ['pending', 'active', 'finished', 'cancelled'],
    default: 'pending',
    index: true
  },
  gift: { type: AuctionGiftSchema, required: true },
  startTime: { type: Number, required: true },
  currentRound: { type: Number, default: -1 },
  roundEndTime: { type: Number },
  authorId: { type: String, required: true, index: true },
  winners: { type: [AuctionWinnerSchema], default: [] },
  rounds: { type: [AuctionRoundSchema], default: [] }
});

// Составной индекс для частых запросов
AuctionSchema.index({ state: 1, startTime: -1 });

export const AuctionModel = model<Auction>('Auction', AuctionSchema);
