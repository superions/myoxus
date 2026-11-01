export interface MyoxusStorageClientContext {
  client: string;
  clientFormat: string;
  clientCapabilities: string;
}

const DEFAULT_STORAGE_CLIENT_CONTEXT: MyoxusStorageClientContext = {
  client: "storage",
  clientFormat: "myoxus-native",
  clientCapabilities: "document-metadata,sync",
};

let storageClientContext: MyoxusStorageClientContext = {
  ...DEFAULT_STORAGE_CLIENT_CONTEXT,
};

export function configureMyoxusStorageClientContext(
  context: Partial<MyoxusStorageClientContext>,
): () => void {
  const previous = storageClientContext;
  storageClientContext = {
    ...DEFAULT_STORAGE_CLIENT_CONTEXT,
    ...context,
  };
  return () => {
    storageClientContext = previous;
  };
}

export function resetMyoxusStorageClientContext() {
  storageClientContext = { ...DEFAULT_STORAGE_CLIENT_CONTEXT };
}

export function getMyoxusStorageClientContext(): MyoxusStorageClientContext {
  return { ...storageClientContext };
}

function storageClientContextHeaders() {
  return {
    "x-myoxus-client": storageClientContext.client,
    "x-myoxus-client-format": storageClientContext.clientFormat,
    "x-myoxus-client-capabilities": storageClientContext.clientCapabilities,
  } as const;
}

function storageSocketClientContext() {
  return {
    client: storageClientContext.client,
    clientFormat: storageClientContext.clientFormat,
    clientCapabilities: storageClientContext.clientCapabilities,
  } as const;
}

export function withMyoxusStorageClientContextHeaders(
  headers?: HeadersInit,
): Headers {
  const merged = new Headers(headers);
  for (const [key, value] of Object.entries(storageClientContextHeaders())) {
    if (!merged.has(key)) {
      merged.set(key, value);
    }
  }
  return merged;
}

export function withMyoxusStorageSocketClientContext<
  Payload extends Record<string, unknown>,
>(payload: Payload): Payload & ReturnType<typeof storageSocketClientContext> {
  return {
    ...payload,
    ...storageSocketClientContext(),
  };
}

export const MYOXUS_STORAGE_SOCKET_CLIENT_CONTEXT =
  DEFAULT_STORAGE_CLIENT_CONTEXT;
