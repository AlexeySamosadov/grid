import { Adapter } from '@solana/wallet-adapter-base';
import React from 'react';
declare const NotInstalled: React.FC<{
    adapter: Adapter;
    onClose: () => void;
    onGoOnboarding: () => void;
}>;
export default NotInstalled;
