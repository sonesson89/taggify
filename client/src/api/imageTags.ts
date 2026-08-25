type ApiErrorPayload = {
  error?: string;
  details?: string;
};

const parseApiErrorMessage = async (
  response: Response,
  fallbackMessage: string,
): Promise<string> => {
  try {
    const payload = (await response.json()) as ApiErrorPayload;
    return payload.details || payload.error || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
};

export const addTagToImage = async (
  fileName: string,
  tagName: string,
  rootFolder?: string,
): Promise<void> => {
  const requestUrl = new URL(`/api/media/${encodeURIComponent(fileName)}/tags`, window.location.origin);
  if (rootFolder) {
    requestUrl.searchParams.set("root", rootFolder);
  }

  const response = await fetch(requestUrl.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tag: tagName }),
  });

  if (!response.ok) {
    const message = await parseApiErrorMessage(
      response,
      `Failed to add tag. Server responded with ${response.status}.`,
    );
    throw new Error(message);
  }
};

export const deleteTagFromImage = async (
  fileName: string,
  tagName: string,
  rootFolder?: string,
): Promise<void> => {
  const requestUrl = new URL(
    `/api/media/${encodeURIComponent(fileName)}/tags/${encodeURIComponent(tagName)}`,
    window.location.origin,
  );
  if (rootFolder) {
    requestUrl.searchParams.set("root", rootFolder);
  }

  const response = await fetch(requestUrl.toString(), {
    method: "DELETE",
  });

  if (!response.ok) {
    const message = await parseApiErrorMessage(
      response,
      `Failed to delete tag. Server responded with ${response.status}.`,
    );
    throw new Error(message);
  }
};

export const deleteMediaFile = async (
  fileName: string,
  rootFolder?: string,
): Promise<void> => {
  const requestUrl = new URL(
    `/api/media/${encodeURIComponent(fileName)}`,
    window.location.origin,
  );
  if (rootFolder) {
    requestUrl.searchParams.set("root", rootFolder);
  }

  const response = await fetch(requestUrl.toString(), {
    method: "DELETE",
  });

  if (!response.ok) {
    const message = await parseApiErrorMessage(
      response,
      `Failed to delete media file. Server responded with ${response.status}.`,
    );
    throw new Error(message);
  }
};
