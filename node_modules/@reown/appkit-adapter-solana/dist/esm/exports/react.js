import { useSnapshot } from 'valtio';
import { SolStoreUtil } from '../src/utils/SolanaStoreUtil.js';
export * from '@reown/appkit-utils/solana';
export * from '../src/index.js';
export function useAppKitConnection() {
    const state = useSnapshot(SolStoreUtil.state);
    return {
        connection: state.connection
    };
}
//# sourceMappingURL=react.js.map