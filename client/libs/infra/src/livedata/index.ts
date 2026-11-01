/**
 * @file index.ts — livedata sub-package of @myoxus/infra
 *
 * Re-exports the full LiveData API:
 *
 *  - {@link LiveData}       — reactive, observable state cell (BehaviorSubject-based)
 *  - {@link PoisonedError}  — thrown when a LiveData enters an unrecoverable error state
 *  - {@link effect}         — reactive side-effect runner tied to LiveData lifetimes
 *  - {@link useLiveData}    — React hook that subscribes a component to a LiveData
 *  - RxJS operator utilities: {@link mapInto}, {@link catchErrorInto}, {@link fromPromise},
 *    {@link backoffRetry}, {@link smartRetry}, {@link exhaustMapSwitchUntilChanged},
 *    {@link onStart}, {@link onComplete}
 */
export { type Effect, effect } from "./effect";
export { LiveData, PoisonedError } from "./livedata";
export {
  AutomaticRetryBlockedError,
  type AutomaticRetryProducer,
  backoffRetry,
  catchErrorInto,
  configureAutomaticRetryAdmission,
  exhaustMapSwitchUntilChanged,
  fromPromise,
  mapInto,
  onComplete,
  onStart,
  reserveAutomaticRetry,
  smartRetry,
} from "./ops";
export { useLiveData } from "./react";
