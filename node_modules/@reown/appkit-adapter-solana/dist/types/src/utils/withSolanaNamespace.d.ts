export declare function withSolanaNamespace<T = string | undefined>(chainId?: T): T extends string ? `solana:${string}` : undefined;
