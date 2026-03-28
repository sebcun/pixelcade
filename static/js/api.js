function csrfToken() {
  return (
    document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ??
    ""
  );
}

async function parseResponseBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function handleResponse(res, data) {
  if (res.status === 401) {
    window.location.assign("/auth/login");
    return data;
  }
  if (!res.ok) {
    const err = data?.error;
    const message =
      err != null && err !== ""
        ? String(err)
        : res.statusText || "Request failed";
    throw new Error(message);
  }
  return data;
}

async function request(method, url, body) {
  const headers = { "Content-Type": "application/json" };
  if (method !== "GET") {
    headers["X-CSRFToken"] = csrfToken();
  }
  const init = {
    method,
    headers,
    credentials: "same-origin",
  };
  if (body !== undefined && method !== "GET") {
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const data = await parseResponseBody(res);
  return handleResponse(res, data);
}

export const api = {
  get(url) {
    return request("GET", url);
  },
  post(url, body) {
    return request("POST", url, body);
  },
  patch(url, body) {
    return request("PATCH", url, body);
  },
  delete(url) {
    return request("DELETE", url);
  },
};
