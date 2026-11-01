/**
 * @file entity.ts — @myoxus/infra (framework/core/components)
 *
 * Base class for parametric, non-singleton components ("entities") in the
 * DI framework.
 *
 * Unlike {@link Service} and {@link Store}, an `Entity` is created on demand
 * with a `Props` object and can be instantiated multiple times within the same
 * provider scope (one instance per unique set of props).  Typical examples
 * include `WorkspaceEntity` or `DocEntity`, where each workspace/document has
 * its own component instance.
 *
 * Create entities via `provider.createEntity(MyEntity, { id: '...' })`.
 *
 * @template Props - The initialisation parameters required to create an instance.
 *
 * Consumers: domain-level entity definitions in `client/web` and `client/admin`.
 */

import { Component } from "./component";

/**
 * Base class for parametric, on-demand component instances ("entities").
 *
 * The `__isEntity` brand field distinguishes entities from services and stores
 * inside the DI container's registry.  Unlike services, entities are not singletons;
 * multiple instances may coexist with different `props`.
 *
 * @template Props - Record of initialisation parameters unique to each entity
 *   instance (e.g. `{ id: string }` for a workspace entity).
 */
export class Entity<Props = {}> extends Component<Props> {
  readonly __isEntity = true;
}
