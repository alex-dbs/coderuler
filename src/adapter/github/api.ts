export function mapping(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function createGithubApi(token?: string): {
  request(path: string, method: 'GET' | 'POST', payload?: object): Promise<Response>;
  json(path: string): Promise<unknown>;
} {
  const request = async (path: string, method: 'GET' | 'POST', payload?: object): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        method,
        redirect: 'manual',
        headers: {
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      throw new Error('GitHub API request failed; check network connectivity to api.github.com.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub API returned HTTP ${response.status}; check GITHUB_TOKEN permissions and pull request access.`);
    }
    return response;
  };
  const json = async (path: string): Promise<unknown> => {
    const response = await request(path, 'GET');
    try {
      return await response.json() as unknown;
    } catch {
      throw new Error('GitHub API returned an invalid response.');
    }
  };
  return { request, json };
}
