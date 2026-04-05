/**
 * SecureVault API client
 *
 * Thin wrapper around the Fetch API that:
 *  - Reads the base URL from VITE_API_URL or falls back to /api
 *  - Attaches the Bearer access-token from the auth store on every request
 *  - Automatically attempts one token refresh on a 401 response
 *  - Exposes type-safe helpers: get, post, put, patch, del
 */

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  /**
   * When true the client will NOT attempt to refresh the access token on
   * a 401.  Set this on the refresh endpoint itself to avoid an infinite
   * loop.
   */
  skipAuthRefresh?: boolean;
}

export interface ApiError {
  status: number;
  message: string;
  code?: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }
}

/* ------------------------------------------------------------------ */
/* Token accessor — lazy-imported to avoid circular dependencies        */
/* ------------------------------------------------------------------ */

/**
 * Returns the current access token without importing the store at
 * module-evaluation time (avoids circular-dependency issues at build time).
 */
function getAccessToken(): string | null {
  // Dynamic import via the global zustand store map is not possible here,
  // so we read the token from sessionStorage where the persist middleware
  // writes it.  The auth store key is 'sv-auth'.
  try {
    const raw = sessionStorage.getItem('sv-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: { accessToken?: string | null };
    };
    return parsed.state?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Attempts to refresh the access token by calling the auth store's
 * refreshToken action.  Returns the new token or null.
 *
 * Using a dynamic import keeps this module free of circular deps.
 */
async function attemptTokenRefresh(): Promise<string | null> {
  try {
    const { useAuthStore } = await import('../stores/authStore');
    return await useAuthStore.getState().refreshToken();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Core fetch wrapper                                                   */
/* ------------------------------------------------------------------ */

const BASE_URL: string =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_API_URL?: string } }).env?.VITE_API_URL) ||
  '/api';

/**
 * Performs a fetch request, adding:
 *  - JSON Content-Type header
 *  - Authorization: Bearer <token>
 *  - One automatic token-refresh retry on 401
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuthRefresh = false, headers: extraHeaders, ...rest } = options;

  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  const buildHeaders = (token: string | null): HeadersInit => {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) {
      h['Authorization'] = `Bearer ${token}`;
    }
    // Merge caller-supplied headers (they can override Content-Type etc.)
    if (extraHeaders) {
      const extra =
        extraHeaders instanceof Headers
          ? Object.fromEntries(extraHeaders.entries())
          : (extraHeaders as Record<string, string>);
      Object.assign(h, extra);
    }
    return h;
  };

  const execute = async (token: string | null): Promise<Response> =>
    fetch(url, {
      method,
      headers: buildHeaders(token),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include', // send HttpOnly refresh-token cookie
      ...rest,
    });

  let token = getAccessToken();
  let response = await execute(token);

  // --- Handle 401: attempt one silent token refresh ---
  if (response.status === 401 && !skipAuthRefresh) {
    const newToken = await attemptTokenRefresh();
    if (newToken) {
      token = newToken;
      response = await execute(token);
    }
  }

  // --- Parse response ---
  if (!response.ok) {
    let errorPayload: ApiError = {
      status: response.status,
      message: response.statusText || 'Request failed',
    };

    try {
      const json = (await response.json()) as {
        message?: string;
        code?: string;
        details?: unknown;
      };
      errorPayload = {
        status: response.status,
        message: json.message ?? response.statusText,
        code: json.code,
        details: json.details,
      };
    } catch {
      // body was not JSON — use the defaults
    }

    throw new ApiRequestError(errorPayload);
  }

  // 204 No Content — return empty object cast to T
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Multipart / file-upload helper                                       */
/* ------------------------------------------------------------------ */

/**
 * Uploads a file (or any FormData payload) without setting Content-Type
 * so the browser can add the multipart boundary automatically.
 */
async function upload<T>(
  path: string,
  formData: FormData,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuthRefresh = false, ...rest } = options;

  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  const token = getAccessToken();

  const buildHeaders = (t: string | null): HeadersInit => {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  const execute = (t: string | null): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: buildHeaders(t),
      body: formData,
      credentials: 'include',
      ...rest,
    });

  let response = await execute(token);

  if (response.status === 401 && !skipAuthRefresh) {
    const newToken = await attemptTokenRefresh();
    if (newToken) {
      response = await execute(newToken);
    }
  }

  if (!response.ok) {
    let errorPayload: ApiError = {
      status: response.status,
      message: response.statusText || 'Upload failed',
    };
    try {
      const json = (await response.json()) as {
        message?: string;
        code?: string;
        details?: unknown;
      };
      errorPayload = {
        status: response.status,
        message: json.message ?? response.statusText,
        code: json.code,
        details: json.details,
      };
    } catch {
      /* ignore */
    }
    throw new ApiRequestError(errorPayload);
  }

  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/* Public API client                                                    */
/* ------------------------------------------------------------------ */

export const apiClient = {
  /** HTTP GET */
  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('GET', path, undefined, options);
  },

  /** HTTP POST with JSON body */
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('POST', path, body, options);
  },

  /** HTTP PUT with JSON body */
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PUT', path, body, options);
  },

  /** HTTP PATCH with JSON body */
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
    return request<T>('PATCH', path, body, options);
  },

  /** HTTP DELETE */
  del<T = void>(path: string, options?: RequestOptions): Promise<T> {
    return request<T>('DELETE', path, undefined, options);
  },

  /** Multipart file upload (POST) */
  upload<T>(
    path: string,
    formData: FormData,
    options?: RequestOptions,
  ): Promise<T> {
    return upload<T>(path, formData, options);
  },
} as const;
