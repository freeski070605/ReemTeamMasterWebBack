import Transaction, { ITransaction } from '../models/Transaction';
import mongoose from 'mongoose';

export class TransactionService {
  static async createTransaction(transactionData: {
    userId: string;
    type: ITransaction['type'];
    amount: number;
    currency: ITransaction['currency'];
    status: ITransaction['status'];
    details?: ITransaction['details'];
  }): Promise<ITransaction> {
    const transaction = new Transaction({
      ...transactionData,
      userId: new mongoose.Types.ObjectId(transactionData.userId),
    });
    await transaction.save();
    return transaction;
  }
}
