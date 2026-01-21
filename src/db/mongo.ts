import mongoose from 'mongoose';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/cryptobot';

export async function connectMongo(): Promise<typeof mongoose> {
  await mongoose.connect(MONGO_URI);
  return mongoose;
}

export { mongoose };
