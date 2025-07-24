import type { Connection } from '@reown/appkit-utils/solana';
export * from '@reown/appkit-utils/solana';
export * from '../src/index.js';
export declare function useAppKitConnection(): {
    connection: Connection | undefined;
};
