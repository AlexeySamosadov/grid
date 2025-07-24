import { proxy, ref, subscribe as sub } from 'valtio';
import { subscribeKey as subKey } from 'valtio/vanilla/utils';
const state = proxy({
    connection: null
});
export const SolStoreUtil = {
    state,
    subscribeKey(key, callback) {
        return subKey(state, key, callback);
    },
    subscribe(callback) {
        return sub(state, () => callback(state));
    },
    setConnection(connection) {
        state.connection = ref(connection);
    }
};
//# sourceMappingURL=SolanaStoreUtil.js.map