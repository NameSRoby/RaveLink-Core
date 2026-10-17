/**
 * TIDAL renderer runtime and native platform capture.
 * Capture only the reviewed native methods needed by the companion. Connection,
 * queue state, and command results stay bounded at the bridge. External desktop
 * client shapes can change; unsupported shapes must stop the operation explicitly
 * rather than fabricate success or retry a possibly completed native write.
 */
// RaveLink's narrow main-world Redux facade. No plugin loader or cloud API.
(function installHooks() {
  if (globalThis.__ravelinkTidal) return;
  const creators = new Map(),
    listeners = new Map(),
    stores = [];
  const allowed = new Set([
    "content/LOAD_SINGLE_MEDIA_ITEM",
    "content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
    "content/LOAD_SINGLE_MEDIA_ITEM_FAIL",
    "playQueue/ADD_MEDIA_ITEMS_TO_QUEUE",
    "playQueue/REMOVE_ELEMENT",
    "playbackControls/SKIP_NEXT",
    "playbackControls/SET_VOLUME",
  ]);
  const currentStore = () =>
    stores.findLast((store) => {
      try {
        const state = store.getState();
        return state?.playQueue && state?.activePlayer;
      } catch {
        return false;
      }
    });
  globalThis.__ravelinkTidal = {
    wrapAction(factory) {
      return function (...args) {
        const creator = factory.apply(this, args),
          type = args[0];
        if (!allowed.has(type)) return creator;
        const wrapped = new Proxy(creator, {
          apply(target, receiver, payload) {
            const result = Reflect.apply(target, receiver, payload);
            for (const listener of listeners.get(type) || []) {
              try {
                listener(result.payload);
              } catch {}
            }
            return result;
          },
        });
        creators.set(type, wrapped);
        return wrapped;
      };
    },
    captureStore(store) {
      if (
        store?.getState &&
        store?.dispatch &&
        store?.subscribe &&
        !stores.includes(store) &&
        stores.length < 16
      )
        stores.push(store);
      return store;
    },
    ready() {
      return Boolean(
        currentStore() &&
        [
          "content/LOAD_SINGLE_MEDIA_ITEM",
          "content/LOAD_SINGLE_MEDIA_ITEM_SUCCESS",
          "content/LOAD_SINGLE_MEDIA_ITEM_FAIL",
          "playQueue/ADD_MEDIA_ITEMS_TO_QUEUE",
        ].every((type) => creators.has(type)),
      );
    },
    redux: {
      store: { getState: () => currentStore()?.getState() },
      actions: new Proxy(
        {},
        {
          get: (_target, type) => {
            if (!allowed.has(type) || !creators.has(type)) return undefined;
            return (payload) => {
              const store = currentStore(),
                creator = creators.get(type);
              if (!store || !creator) throw new Error("tidal_hooks_unavailable");
              return store.dispatch(creator(payload));
            };
          },
        },
      ),
      interceptActionResp(
        trigger,
        unloads,
        success,
        failure,
        { timeoutMs = 3500, predicate } = {},
      ) {
        return new Promise((resolve, reject) => {
          let timer,
            done = false;
          const removals = [];
          const finish = (error, value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            for (const remove of removals) remove();
            unloads?.delete(cancel);
            error ? reject(new Error(error)) : resolve(value);
          };
          const cancel = () => finish("tidal_companion_stopped");
          for (const [types, failed] of [
            [success, false],
            [failure || [], true],
          ])
            for (const type of types) {
              const set = listeners.get(type) || new Set();
              listeners.set(type, set);
              const listener = (value) => {
                if (!predicate || predicate(value))
                  finish(failed ? "tidal_metadata_failed" : "", value);
              };
              set.add(listener);
              removals.push(() => set.delete(listener));
            }
          unloads?.add(cancel);
          timer = setTimeout(() => finish("tidal_metadata_timeout"), timeoutMs);
          try {
            trigger();
          } catch {
            finish("tidal_hooks_unavailable");
          }
        });
      },
    },
  };
})();
