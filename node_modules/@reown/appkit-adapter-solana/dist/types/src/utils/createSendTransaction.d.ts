import { type Connection, Transaction } from '@solana/web3.js';
import type { Provider } from '@reown/appkit-utils/solana';
type SendTransactionArgs = {
    provider: Provider;
    connection: Connection;
    to: string;
    value: number;
};
export declare function createSendTransaction({ provider, to, value, connection }: SendTransactionArgs): Promise<Transaction>;
export {};
