import { ref } from 'vue';
import { SolStoreUtil } from '../src/utils/SolanaStoreUtil.js';
export * from '@reown/appkit-utils/solana';
export * from '../src/index.js';
export function useAppKitConnection() {
    const state = ref(SolStoreUtil.state);
    return {
        connection: state.value.connection
    };
}
//# sourceMappingURL=vue.js.map