import type { ProviderEventEmitterMethods } from '@reown/appkit-utils/solana';
export declare class ProviderEventEmitter implements ProviderEventEmitterMethods {
    private listeners;
    on<E extends ProviderEventEmitterMethods.Event>(event: E, listener: (data: ProviderEventEmitterMethods.EventParams[E]) => void): void;
    removeListener<E extends ProviderEventEmitterMethods.Event>(event: E, listener: (data: ProviderEventEmitterMethods.EventParams[E]) => void): void;
    emit<E extends ProviderEventEmitterMethods.Event>(event: E, data: ProviderEventEmitterMethods.EventParams[E]): void;
}
