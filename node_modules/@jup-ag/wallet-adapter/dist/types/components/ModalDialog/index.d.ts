import React, { PropsWithChildren } from 'react';
declare const ModalDialog: React.FC<{
    open: boolean;
    onClose: () => void;
} & PropsWithChildren>;
export default ModalDialog;
