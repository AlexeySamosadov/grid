import { WalletContextState } from '@solana/wallet-adapter-react';
import { Adapter } from '@solana/wallet-adapter-base';
import { IUnifiedWalletConfig } from './WalletConnectionProvider';
import { useUnifiedWallet, useUnifiedWalletContext } from './UnifiedWalletContext';
export type IWalletProps = Omit<WalletContextState, 'autoConnect' | 'disconnecting' | 'sendTransaction' | 'signTransaction' | 'signAllTransactions' | 'signMessage'>;
declare const UnifiedWalletProvider: ({ wallets, config, children, }: {
    wallets: Adapter[];
    config: IUnifiedWalletConfig;
    children: React.ReactNode;
}) => import("@emotion/react/types/jsx-namespace").EmotionJSX.Element;
export { UnifiedWalletProvider, useUnifiedWallet, useUnifiedWalletContext };
