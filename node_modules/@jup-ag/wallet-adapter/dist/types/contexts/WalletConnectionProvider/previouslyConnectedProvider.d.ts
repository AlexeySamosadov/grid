import React from 'react';
declare const PreviouslyConnectedContext: React.Context<string[]>;
declare const PreviouslyConnectedProvider: React.FC<{
    children: React.ReactNode;
}>;
declare const usePreviouslyConnected: () => string[];
export { PreviouslyConnectedProvider, usePreviouslyConnected };
export default PreviouslyConnectedContext;
