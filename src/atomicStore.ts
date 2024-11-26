import { atom } from 'jotai';
import type { Atom, WritableAtom, PrimitiveAtom } from 'jotai';

// Helper type to detect if two types are exactly equal
type IfEquals<X, Y, A = X, B = never> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? A : B;

// Helper type to get writable keys of an object
type WritableKeys<T> = {
  [P in keyof T]: IfEquals<
    { [Q in P]: T[P] },
    { -readonly [Q in P]: T[P] },
    P,
    never
  >;
}[keyof T];

/** Get state keys (non-function properties) */
type StateKeys<T> = {
  [K in keyof T]: T[K] extends Function ? never : K;
}[keyof T];

/** Valid state update type that enforces exact object literal checking */
type StateUpdate<T> = {
  [K in StateKeys<T>]?: T[K];
} & {}; // The intersection with empty object helps preserve literal type checking

/** Valid return types for store actions */
type ValidActionReturn<T> = void | StateUpdate<T>;

/** Store definition type */
export type AtomicDefinition<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => any
    ? (...args: Args) => ValidActionReturn<T>
    : T[K];
};

/** Generated store type where each property becomes a Jotai atom */
type AtomicStore<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => any
    ? WritableAtom<void, Parameters<T[K]>, void>
    : K extends WritableKeys<T>
      ? PrimitiveAtom<T[K]>
      : Atom<T[K]>;
};

const ACTION = Symbol('ACTION'); // Unique symbol to denote action atoms

/**
 * Creates an atomic store that combines Zustand-like state definition with Jotai atoms.
 *
 * The state definition object passed to this function can consist of three kinds of properties:
 *
 * **Base State**
 *    - Regular properties (not functions or getters)
 *    - Stored in a single root atom for efficient updates
 *    - Becomes a `PrimitiveAtom<Value>` in the store
 *
 * **Derived State**
 *    - Defined using property getters
 *    - Auto-updates when dependencies change
 *    - Cached by Jotai to prevent unnecessary recomputation
 *    - Becomes a read-only `Atom<Value>` in the store
 *
 * **Actions**
 *    - Regular functions that can update state
 *    - Can return partial `Partial<State>` updates or modify state via `this`
 *    - Becomes a `WritableAtom<void, Args, void>` in the store
 *
 * @returns An object where each property is converted to a Jotai atom:
 *    - Base state becomes a primitive atom: `PrimitiveAtom<Value>`
 *    - Derived state becomes a read-only atom: `Atom<Value>`
 *    - Actions become writable atoms: `WritableAtom<void, Args, void>`
 *
 * @example Basic store definition
 * ```ts
 * const store = createAtomicStore({
 *   count: 0,
 *   get double() { return this.count * 2 },
 *   increment(n = 1) { return { count: this.count + n } }
 * })
 * ```
 *
 * @example Usage with React hooks
 * ```tsx
 * function Counter() {
 *   // Read base or derived state with useAtomValue
 *   const count = useAtomValue(store.count)
 *   const double = useAtomValue(store.double)
 *
 *   // Get action setter with useSetAtom
 *   const increment = useSetAtom(store.increment)
 *
 *   return (
 *     <div>
 *       <p>Count: {count}</p>
 *       <p>Double: {double}</p>
 *       <button onClick={() => increment()}>+1</button>
 *       <button onClick={() => increment(5)}>+5</button>
 *     </div>
 *   )
 * }
 * ```
 *
 * @example Direct usage with Jotai store
 * ```ts
 * const jotai = createStore()
 *
 * // Read values
 * const count = jotai.get(store.count)
 * const double = jotai.get(store.double)
 *
 * // Update base state
 * jotai.set(store.count, 42)
 *
 * // Call actions
 * jotai.set(store.increment)
 * ```
 *
 * @template State - Type of the state definition object
 */
export function createAtomicStore<State extends object>(
  definition: AtomicDefinition<State>,
): AtomicStore<State> {
  const store = {} as AtomicStore<State>;
  const baseAtoms = new Map<keyof State, PrimitiveAtom<any>>();

  // Create a single root atom for all base state values
  const baseValues = {} as Record<keyof State, any>;
  for (const key of Object.keys(definition)) {
    const k = key as keyof State;
    const desc = Object.getOwnPropertyDescriptor(definition, k);
    if (
      desc &&
      !desc.get && // Not derived state
      typeof desc.value !== 'function' // Not an action
    ) {
      baseValues[k] = desc.value;
    }
  }
  const rootAtom = atom(baseValues);

  // Create atoms for each base state property
  for (const key of Object.keys(baseValues)) {
    const k = key as keyof State;
    const baseAtom = atom(
      (get) => get(rootAtom)[k],
      (get, set, update: State[typeof k]) => {
        const current = get(rootAtom);
        set(rootAtom, { ...current, [k]: update });
      },
    ) as PrimitiveAtom<State[typeof k]>;
    baseAtoms.set(k, baseAtom);
    store[k] = baseAtom as AtomicStore<State>[typeof k];
  }

  // Create derived state atoms
  for (const [key, desc] of Object.entries(
    Object.getOwnPropertyDescriptors(definition),
  )) {
    if (!desc.get) continue;
    const k = key as keyof State;
    const derivedAtom = atom((get) => {
      const state = Object.create(null) as State;
      for (const propKey of Object.keys(definition)) {
        const pk = propKey as keyof State;
        Object.defineProperty(state, pk, {
          get() {
            if (baseAtoms.has(pk)) return get(baseAtoms.get(pk)!);
            return get(store[pk] as Atom<any>);
          },
          enumerable: true,
        });
      }
      return desc.get!.call(state);
    });
    store[k] = derivedAtom as AtomicStore<State>[typeof k];
  }

  // Create action atoms
  for (const key of Object.keys(definition)) {
    const k = key as keyof State;
    const desc = Object.getOwnPropertyDescriptor(definition, k);
    if (
      !desc ||
      typeof desc.value !== 'function' || // Not an action
      desc.get // Skip getters (derived state)
    )
      continue;
    type Args = State[typeof k] extends (...args: infer P) => any ? P : never;
    const actionAtom = atom(ACTION, (get, set, ...args: Args) => {
      const state = Object.create(null) as State;
      for (const propKey of Object.keys(definition)) {
        const pk = propKey as keyof State;
        Object.defineProperty(state, pk, {
          get() {
            if (baseAtoms.has(pk)) return get(baseAtoms.get(pk)!);
            return get(store[pk] as Atom<any>);
          },
          set(value: any) {
            if (baseAtoms.has(pk)) {
              set(baseAtoms.get(pk)!, value);
            } else {
              throw new Error(`Cannot set value for derived state or actions.`);
            }
          },
          enumerable: true,
        });
      }
      const result = desc.value.apply(state, args);
      if (result)
        for (const [key, value] of Object.entries(result))
          if (baseAtoms.has(key as keyof State))
            set(baseAtoms.get(key as keyof State)!, value);
    }) as WritableAtom<void, Args, void>;
    store[k] = actionAtom as AtomicStore<State>[typeof k];
  }

  return store;
}
