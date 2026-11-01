import { effect, signal } from "@preact/signals-core";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { createMutex } from "lib0/mutex.js";
import * as Y from "yjs";

import {
  Boxed,
  Text,
  createYProxy,
  native2Y,
  type UnRecord,
  y2Native,
} from "../../reactive/index.js";
import { projectSchemaDefault } from "../../reactive/schema-default.js";
import { resolveFlavour } from "../../schema/flavour-alias.js";
import type { Schema } from "../../schema/schema.js";
import type { Store } from "../store/store.js";
import { BlockModel } from "./block-model.js";
import type { YBlock } from "./types.js";
import { internalPrimitives } from "./zod.js";

/**
 * @internal
 * SyncController is responsible for syncing the block data with Yjs.
 * It creates a proxy model that syncs with Yjs and provides a reactive interface.
 * It also handles the stashing and popping of props.
 * It will also provide signals for block props.
 *
 */
export class SyncController {
  private _byPassProxy: boolean = false;

  // A signal effect may flush after a surrounding batch releases the mutex.
  // Remember the exact projected value so its delayed echo cannot replace a
  // Y.Map again; independent signal assignments still write through normally.
  private readonly _projectedSignalValues = new Map<string, unknown>();

  private readonly _byPassUpdate = (fn: () => void) => {
    const previous = this._byPassProxy;
    this._byPassProxy = true;
    try {
      fn();
    } finally {
      this._byPassProxy = previous;
    }
  };

  private readonly _mutex = createMutex();

  private readonly _observeYBlockChanges = () => {
    this.yBlock.observe((event) => {
      event.keysChanged.forEach((key) => {
        const type = event.changes.keys.get(key);
        if (!type) {
          return;
        }
        const isLocal =
          !this.yBlock.doc ||
          !event.transaction.origin ||
          event.transaction.origin instanceof Y.UndoManager ||
          event.transaction.origin.proxy
            ? true
            : event.transaction.origin === this.yBlock.doc.clientID;
        if (type.action === "update" || type.action === "add") {
          const value = this.yBlock.get(key);
          const keyName = key.replace("prop:", "");
          const proxy = this._getPropsProxy(keyName, value);
          this._byPassUpdate(() => {
            // @ts-expect-error allow magic props
            this.model.props[keyName] = proxy;
            const signalKey = `${keyName}$`;
            this._mutex(() => {
              if (signalKey in this.model.props) {
                const projected = y2Native(value);
                this._projectedSignalValues.set(keyName, projected);
                // @ts-expect-error allow magic props
                this.model.props[signalKey].value = projected;
              }
            });
          });
          this.onChange?.(keyName, isLocal);
          return;
        }
        if (type.action === "delete") {
          const keyName = key.replace("prop:", "");
          this._byPassUpdate(() => {
            // @ts-expect-error allow magic props
            delete this.model.props[keyName];
            if (`${keyName}$` in this.model.props) {
              this._projectedSignalValues.set(keyName, undefined);
              // @ts-expect-error allow magic props
              this.model.props[`${keyName}$`].value = undefined;
            }
          });
          this.onChange?.(keyName, isLocal);
          return;
        }
      });
    });
  };

  private readonly _stashed = new Set<string | number>();

  readonly flavour: string;

  readonly id: string;

  readonly model: BlockModel;

  readonly pop = (prop: string) => {
    if (!this._stashed.has(prop)) return;
    this._popProp(prop);
  };

  readonly stash = (prop: string) => {
    if (this._stashed.has(prop)) return;

    this._stashed.add(prop);
    this._stashProp(prop);
  };

  readonly version: number;

  readonly yChildren: Y.Array<string[]>;

  constructor(
    readonly schema: Schema,
    readonly yBlock: YBlock,
    readonly doc?: Store,
    readonly onChange?: (key: string, isLocal: boolean) => void,
  ) {
    const { id, flavour, version, yChildren, props } = this._parseYBlock();

    this.id = id;
    this.flavour = flavour;
    this.yChildren = yChildren;
    this.version = version;

    this.model = this._createModel(props);

    this._observeYBlockChanges();
  }

  private _createModel(props: UnRecord) {
    const _mutex = this._mutex;
    const projectedSignalValues = this._projectedSignalValues;
    const schema = this.schema.flavourSchemaMap.get(this.flavour);
    if (!schema) {
      throw new VirgultumError(
        ErrorCode.ModelCRUDError,
        `schema for flavour: ${this.flavour} not found`,
      );
    }

    const model = schema.model.toModel?.() ?? new BlockModel<object>();
    model.schema = schema;
    const signalWithProps = Object.entries(props).reduce(
      (acc, [key, value]) => {
        const data = signal(value);
        const dispose = effect(() => {
          const value = data.value;
          if (!this.model) return;
          if (
            projectedSignalValues.has(key) &&
            Object.is(value, projectedSignalValues.get(key))
          )
            return;
          _mutex(() => {
            // @ts-expect-error allow magic props
            this.model.props[key] = value;
          });
        });
        const subscription = model.deleted.subscribe(() => {
          subscription.unsubscribe();
          dispose();
        });
        return {
          ...acc,
          [`${key}$`]: data,
          [key]: value,
        };
      },
      {} as Record<string, unknown>,
    );

    model.id = this.id;
    model.keys = Object.keys(props);
    model.yBlock = this.yBlock;
    model.stash = this.stash;
    model.pop = this.pop;
    if (this.doc) {
      model.store = this.doc;
    }

    const proxy = new Proxy(signalWithProps, {
      has: (target, p) => {
        return Reflect.has(target, p);
      },
      set: (target, p, value, receiver) => {
        if (
          !this._byPassProxy &&
          typeof p === "string" &&
          model.keys.includes(p)
        ) {
          if (this._stashed.has(p)) {
            setValue(target, p, value);
            const result = Reflect.set(target, p, value, receiver);
            this.onChange?.(p, true);
            return result;
          }

          const yValue = native2Y(value);
          if (this.yBlock.get(`prop:${p}`) === yValue) {
            return Reflect.set(target, p, value, receiver);
          }
          this.yBlock.set(`prop:${p}`, yValue);
          const proxy = this._getPropsProxy(p, yValue);
          setValue(target, p, value);
          return Reflect.set(target, p, proxy, receiver);
        }

        return Reflect.set(target, p, value, receiver);
      },
      get: (target, p, receiver) => {
        return Reflect.get(target, p, receiver);
      },
      deleteProperty: (target, p) => {
        if (
          !this._byPassProxy &&
          typeof p === "string" &&
          model.keys.includes(p)
        ) {
          this.yBlock.delete(`prop:${p}`);
          setValue(target, p, undefined);
        }

        return Reflect.deleteProperty(target, p);
      },
    });
    model._props = proxy;

    function setValue(target: UnRecord, p: string, value: unknown) {
      projectedSignalValues.set(p, value);
      _mutex(() => {
        // @ts-expect-error allow magic props
        target[`${p}$`].value = value;
      });
    }
    return model;
  }

  private _getPropsProxy(name: string, value: unknown) {
    return createYProxy(value, {
      onChange: (_, isLocal) => {
        this.onChange?.(name, isLocal);
        const signalKey = `${name}$`;
        if (signalKey in this.model.props) {
          this._mutex(() => {
            const projected = y2Native(value);
            this._projectedSignalValues.set(name, projected);
            // @ts-expect-error allow magic props
            this.model.props[signalKey].value = projected;
          });
        }
      },
    });
  }

  private _parseYBlock() {
    let id: string | undefined;
    let flavour: string | undefined;
    let version: number | undefined;
    let yChildren: Y.Array<string[]> | undefined;
    const props: Record<string, unknown> = {};

    this.yBlock.forEach((value, key) => {
      if (key.startsWith("prop:")) {
        const keyName = key.replace("prop:", "");
        props[keyName] = this._getPropsProxy(keyName, value);
        return;
      }
      if (key === "sys:id" && typeof value === "string") {
        id = value;
        return;
      }
      if (key === "sys:flavour" && typeof value === "string") {
        flavour = resolveFlavour(value);
        return;
      }
      if (key === "sys:children" && value instanceof Y.Array) {
        yChildren = value;
        return;
      }
      if (key === "sys:version" && typeof value === "number") {
        version = value;
        return;
      }
    });

    if (!id) {
      throw new VirgultumError(
        ErrorCode.ModelCRUDError,
        "block id is not found when creating model",
      );
    }
    if (!flavour) {
      throw new VirgultumError(
        ErrorCode.ModelCRUDError,
        "block flavour is not found when creating model",
      );
    }
    if (!yChildren) {
      throw new VirgultumError(
        ErrorCode.ModelCRUDError,
        "block children is not found when creating model",
      );
    }

    const schema = this.schema.flavourSchemaMap.get(flavour);
    if (!schema) {
      throw new VirgultumError(
        ErrorCode.ModelCRUDError,
        `schema for flavour: ${flavour} not found`,
      );
    }
    const defaultProps = schema.model.props?.(internalPrimitives);

    if (typeof version !== "number") {
      // no version found in data, set to schema version
      version = schema.version;
    }

    // Set default props if not exists
    if (defaultProps) {
      Object.entries(defaultProps).forEach(([key, value]) => {
        if (key in props) return;

        // Hydrating native defaults is not an authored edit. Shared content
        // containers retain their existing initialization; ordinary defaults
        // stay projected until an actual scalar or nested edit writes them.
        if (this.doc?.readonly) {
          props[key] = value;
        } else if (value instanceof Text || value instanceof Boxed) {
          const yValue = native2Y(value);
          if (value !== undefined) {
            this.yBlock.set(`prop:${key}`, yValue);
          }
          props[key] = this._getPropsProxy(key, yValue);
        } else {
          const projected = projectSchemaDefault(
            value,
            () => {
              if (!this.model) return undefined;
              const current = Reflect.get(this.model.props, key);
              return current === projected ? undefined : { value: current };
            },
            (value) => {
              if (this._stashed.has(key))
                Reflect.set(this.model.props, key, value);
              else this.yBlock.set(`prop:${key}`, native2Y(value));
            },
          );
          props[key] = projected;
        }
      });
    }

    return {
      id,
      flavour,
      version,
      props,
      yChildren,
    };
  }

  private _popProp(prop: string) {
    const model = this.model as BlockModel<Record<string, unknown>>;

    const value = model.props[prop];
    this._stashed.delete(prop);
    model.props[prop] = value;
  }

  private _stashProp(prop: string) {
    // An unpersisted native default is already a local projection. Stashing it
    // must neither erase that value nor materialize it before pop.
    if (!this.yBlock.has(`prop:${prop}`)) return;
    (this.model as BlockModel<Record<string, unknown>>).props[prop] = y2Native(
      this.yBlock.get(`prop:${prop}`),
      {
        transform: (value, origin) => {
          if (Boxed.is(origin)) {
            return value;
          }
          if (origin instanceof Y.Map) {
            return new Proxy(value as UnRecord, {
              get: (target, p, receiver) => {
                return Reflect.get(target, p, receiver);
              },
              set: (target, p, value, receiver) => {
                const result = Reflect.set(target, p, value, receiver);
                this.onChange?.(prop, true);
                return result;
              },
              deleteProperty: (target, p) => {
                const result = Reflect.deleteProperty(target, p);
                this.onChange?.(prop, true);
                return result;
              },
            });
          }
          if (origin instanceof Y.Array) {
            return new Proxy(value as unknown[], {
              get: (target, p, receiver) => {
                return Reflect.get(target, p, receiver);
              },
              set: (target, p, value, receiver) => {
                const index = Number(p);
                if (Number.isNaN(index)) {
                  return Reflect.set(target, p, value, receiver);
                }
                const result = Reflect.set(target, p, value, receiver);
                this.onChange?.(prop, true);
                return result;
              },
              deleteProperty: (target, p) => {
                const result = Reflect.deleteProperty(target, p);
                this.onChange?.(p as string, true);
                return result;
              },
            });
          }

          return value;
        },
      },
    );
  }
}
