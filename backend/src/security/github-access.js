import { HttpError, positiveId } from "./http-safety.js";

async function userResponse(apiFetch, token, endpoint) {
  if (!token) throw new HttpError(403, "Reconnect GitHub to verify repository access.");
  const response = await apiFetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  if ([401, 403, 404].includes(response.status)) {
    throw new HttpError(
      403,
      "GitHub access denied. Reconnect GitHub if your authorization expired.",
    );
  }
  if (!response.ok) throw new HttpError(502, "Unable to verify GitHub access.");
  return response.json();
}

export async function verifyUserInstallation({ apiFetch, accessToken, installationId, appId }) {
  const id = positiveId(installationId);
  if (!id) throw new HttpError(400, "Invalid installation id.");
  // Never use an App JWT or installation token to decide a user's permissions.
  for (let page = 1; page <= 100; page += 1) {
    const payload = await userResponse(
      apiFetch,
      accessToken,
      `user/installations?per_page=100&page=${page}`,
    );
    if (!Array.isArray(payload?.installations))
      throw new HttpError(502, "Invalid GitHub response.");
    const match = payload.installations.find(
      (item) =>
        Number(item.id) === id && Number(item.app_id) === Number(appId) && !item.suspended_at,
    );
    if (match) return match;
    if (payload.installations.length < 100) break;
  }
  throw new HttpError(403, "This GitHub installation is not accessible to your account.");
}

export async function userInstallationRepositories({ apiFetch, accessToken, installationId }) {
  const id = positiveId(installationId);
  if (!id) throw new HttpError(400, "Invalid installation id.");
  const repos = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await userResponse(
      apiFetch,
      accessToken,
      `user/installations/${id}/repositories?per_page=100&page=${page}`,
    );
    if (!Array.isArray(payload?.repositories)) throw new HttpError(502, "Invalid GitHub response.");
    repos.push(...payload.repositories);
    if (payload.repositories.length < 100) return repos;
  }
  throw new HttpError(502, "GitHub repository listing exceeded the supported page count.");
}
