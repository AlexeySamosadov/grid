import React, { ReactNode } from 'react';
export interface WalletModalProps {
    className?: string;
    logo?: ReactNode;
    container?: string;
}
interface IUnifiedWalletModal {
    onClose: () => void;
}
declare const UnifiedWalletModal: React.FC<IUnifiedWalletModal>;
export default UnifiedWalletModal;
